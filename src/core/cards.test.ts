// One-press cards for trades and swaps, with no vaults, factors or windows. Pins that an expired card
// never executes, that the hash binds what runs, the limits, a mint Candle doesn't know, and that one
// agent's card can't spend another's key.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Redactor } from "../shared/redact"
import type { AgentStatus } from "./agent-status"
import { BASE_ASSETS } from "./assets"
import type { ToolOutcome } from "./candle-mcp"
import type { WalletSetting } from "./autonomy"
import { type Card, CardBook, type CardBookDeps, CARDS_LIST_BYTES, CLOSED_CARDS_KEPT, hashCard, launchPublishes, launchTerms } from "./cards"
import { classify, type Mode } from "./classify"
import { Journal } from "./journal"
import { byWalletWithoutCard, DaySpend, KeyHolds, Limits } from "./limits"
import { Markets } from "./markets"
import type { Quote } from "./pricing"
import type { FaceClient } from "./tool-face"

const MOON = "MoonFake11111111111111111111111111111111111"
const PEPE = "PepeFake11111111111111111111111111111111111"
const GHOST = "GhostFake1111111111111111111111111111111111"
const WALLET = "WalletFake111111111111111111111111111111111"
const SOL = BASE_ASSETS.SOL.priceKey!
const USDC = BASE_ASSETS.USDC.priceKey!
const T0 = new Date(2026, 9, 26, 12, 0, 0).getTime()
const HARNESS: FaceClient = { clientId: "h1", role: "harness", agent: "momentum" }
const VIEW = "v1"

const dirs: string[] = []
const journals: Journal[] = []
const books: CardBook[] = []
afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close().catch(() => {})
  for (const book of books.splice(0)) book.stop()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function status(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return { readAt: 0, wallets: { solana: WALLET }, embeddedWallet: "allowed", feeBps: 50, keyLimit: { usd: 100, reset: "daily" }, unreadable: [], ...overrides }
}

function market(mint: string, extra: Record<string, unknown> = {}): ToolOutcome {
  return {
    kind: "ok",
    result: {
      success: true,
      market: { chain: "solana", mint, candleLaunched: true, quoteMint: SOL, decimals: 6, quoteDecimals: 9, trade: { routable: true }, metadata: { symbol: mint === MOON ? "MOON" : "PEPE" }, ...extra },
    },
  }
}

async function setup(
  opts: {
    /** The operation's write-ahead row fails, as a full disk would. */
    executeThrows?: boolean
    /** The paused refusal's write-ahead row fails, as a full disk would. */
    refusePausedThrows?: boolean
    statuses?: Record<string, AgentStatus>
    prices?: Record<string, number>
    resolve?: Record<string, ToolOutcome>
    holdings?: Record<string, bigint>
    spendAsset?: "SOL" | "USDC" | "CNDL"
    quote?: (trade: { mint: string; side: string; amountRaw: string; quoteAsset?: string }) => Quote | undefined
    /** The agent's MCP child, for the dry runs and reads a card makes when it's proposed. */
    candle?: (tool: string, args: Record<string, unknown>) => ToolOutcome
    /** Which wallet pays: a TEE wallet's card runs through the CLI. */
    wallets?: CardBookDeps["wallets"]
    /** The core's operations, those a restart rebuilt included. */
    operations?: CardBookDeps["operations"]
    /** The other mints the core has read a token's name for. */
    otherMints?: CardBookDeps["otherMints"]
    /** Whether a harness token's turn was stopped. */
    turnEnded?: CardBookDeps["turnEnded"]
    /** The turn a harness token was minted for. */
    turnOf?: CardBookDeps["turnOf"]
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "chrn-cards-"))
  dirs.push(dir)
  let now = T0
  const journal = await Journal.open({ path: join(dir, "journal.jsonl"), redactor: new Redactor(), account: "acct_fake", now: () => now })
  journals.push(journal)
  const network: string[] = []
  let networkAllowed = true
  const resolves: Record<string, ToolOutcome> = { [MOON]: market(MOON), [PEPE]: market(PEPE, { candleLaunched: false, external: true, decimals: undefined }), ...opts.resolve }
  const markets = new Markets({
    pool: {
      for: (agent) => ({
        call: async (name, args) => {
          network.push(`${agent}:${name}`)
          if (!networkAllowed) throw new Error("network call during approve")
          return resolves[String(args.mint)] ?? { kind: "error", code: "MARKET_NOT_FOUND", retryable: false, body: {} }
        },
      }),
    },
  })
  const statuses = new Map(Object.entries(opts.statuses ?? { momentum: status(), swing: status() }))
  const prices = new Map(Object.entries(opts.prices ?? { [SOL]: 150, [USDC]: 1, [MOON]: 0.63 }))
  const spend = new DaySpend()
  const walletSpend = new DaySpend(byWalletWithoutCard)
  const holds = new KeyHolds({ window: (agent) => statuses.get(agent)?.keyLimit })
  const executed: Card[] = []
  const candleCalls: { agent: string; tool: string; args: Record<string, unknown> }[] = []
  let release: (() => void) | undefined
  let mode: Mode = "live"
  let paused = false
  // Each wallet's autonomy: every wallet asks unless a test sets it.
  const autonomy = new Map<string, WalletSetting>()
  const deps: CardBookDeps = {
    journal,
    account: "acct_fake",
    now: () => now,
    mode: () => mode,
    agents: () => [...statuses.keys()],
    keyPrefix: (agent) => `${agent.slice(0, 4)}Ab3d`, // the 8-character prefix `candle keys list` prints
    status: { get: (agent) => statuses.get(agent) },
    markets,
    spendAsset: () => opts.spendAsset ?? "SOL",
    holding: async (agent, wallet, mint) => {
      network.push(`${agent}:candle_get_portfolio`)
      if (!networkAllowed) throw new Error("network call during approve")
      const raw = (opts.holdings ?? { [MOON]: 12_345_678_901n })[mint]
      return raw === undefined ? "none" : { amountRaw: raw, decimals: 6 }
    },
    // Prices "read now" from the same table a test changes; each read is a network call, refused during approve.
    pricing: {
      asset: async (agent, asset) => {
        network.push(`${agent}:price ${asset}`)
        if (!networkAllowed) throw new Error("network call during approve")
        const usd = BASE_ASSETS[asset].priceKey === undefined ? undefined : prices.get(BASE_ASSETS[asset].priceKey!)
        return usd === undefined ? undefined : { usd, at: now, source: "test" }
      },
      token: async (agent, _chain, mint) => {
        network.push(`${agent}:price ${mint}`)
        if (!networkAllowed) throw new Error("network call during approve")
        const usd = prices.get(mint)
        return usd === undefined ? undefined : { usd, at: now, source: "test" }
      },
      quote: async (agent, trade) => {
        if (!opts.quote) return undefined
        network.push(`${agent}:quote`)
        return opts.quote(trade)
      },
    },
    limits: new Limits({ limitsFor: (a) => (statuses.has(a) ? { perTradeUsd: 10, perDayUsd: 50 } : undefined), spend }),
    spend,
    walletSpend,
    holds,
    autonomy: { get: (wallet) => autonomy.get(wallet) ?? { setting: "ask" } },
    ...(opts.wallets ? { wallets: opts.wallets } : {}),
    ...(opts.operations ? { operations: opts.operations } : {}),
    ...(opts.otherMints ? { otherMints: opts.otherMints } : {}),
    ...(opts.turnEnded ? { turnEnded: opts.turnEnded } : {}),
    ...(opts.turnOf ? { turnOf: opts.turnOf } : {}),
    paused: () => paused,
    candle: async (agent, tool, args) => {
      network.push(`${agent}:${tool}`)
      candleCalls.push({ agent, tool, args: structuredClone(args) })
      if (!networkAllowed) throw new Error("network call during approve")
      return opts.candle ? opts.candle(tool, args) : { kind: "error", code: "FAKE_NOT_SCRIPTED", retryable: false, body: {} }
    },
    ...(opts.refusePausedThrows
      ? {
          refusePaused: async () => {
            throw new Error("disk full")
          },
        }
      : {}),
    execute: async (card) => {
      if (opts.executeThrows) throw new Error("disk full")
      executed.push(card)
      if (release === undefined) return { state: "submitting" as const }
      await new Promise<void>((resolve) => {
        const r = release!
        release = () => {
          r()
          resolve()
        }
      })
      return { state: "submitting" as const }
    },
  }
  const book = new CardBook(deps)
  books.push(book)
  return {
    book,
    journal,
    executed,
    network,
    candleCalls,
    spend,
    walletSpend,
    holds,
    now: () => now,
    statuses,
    prices,
    tick: (ms: number) => (now += ms),
    setMode: (m: Mode) => (mode = m),
    setPaused: (p: boolean) => (paused = p),
    setWallet: (wallet: string, setting: WalletSetting) => autonomy.set(wallet, setting),
    blockNetwork: () => (networkAllowed = false),
    holdExecution: () => {
      let resolve!: () => void
      const gate = new Promise<void>((r) => (resolve = r))
      release = () => resolve()
      return { gate, open: () => release!() }
    },
    propose: (args: Record<string, unknown>, extra: { tool?: string; client?: FaceClient; reason?: string } = {}) => {
      const tool = extra.tool ?? "candle_trade"
      const client = extra.client ?? HARNESS
      const verdict = classify(tool, {}, "live")
      const { kind, idKey } = verdict.class === "card" ? verdict : { kind: "unknown" as const, idKey: "coreOpId" as const }
      return book.propose({ client, agent: client.agent, tool, args, params: args, kind, idKey, ...(extra.reason !== undefined ? { reason: extra.reason } : {}) })
    },
  }
}

const buy = (amount = "0.05", mint = MOON) => ({ mint, side: "buy", amount })

async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string; details: Record<string, unknown> }> {
  try {
    await promise
  } catch (error) {
    const e = error as { code: string; message: string; details?: Record<string, unknown> }
    return { code: e.code, message: e.message, details: e.details ?? {} }
  }
  throw new Error("expected a refusal")
}

describe("sizing a buy in dollars (amountUsd)", () => {
  const usdBuy = (amountUsd: unknown, mint = MOON, extra: Record<string, unknown> = {}) => ({ mint, side: "buy", amountUsd, ...extra })

  test("it becomes an amount of the pair asset at the price now, and the hash binds that amount", async () => {
    const s = await setup()
    // $5 at $150 a SOL, rounded down to SOL's 9 decimals.
    const card = await s.propose(usdBuy("5"))
    expect(card.params).toEqual({ mint: MOON, side: "buy", amount: "0.033333333", clientTradeId: card.opId })
    expect(card.display.title).toBe("BUY 0.033333333 SOL (≈$5.00) → MOON")
    expect(card.display.sizedFromUsd).toBe("$5.00 at SOL $150.00")
    expect(card.cardHash).toBe(
      hashCard({ kind: "trade", tool: "candle_trade", params: card.params, opId: card.opId, account: "acct_fake", agent: "momentum", wallet: WALLET, mode: "live" }),
    )
    expect(card.asked).toMatchObject({ amountUsd: "5" })
  })

  test("a token Candle didn't launch spends the configured asset; one Candle launched spends its own pair", async () => {
    const s = await setup({ spendAsset: "USDC" })
    const external = await s.propose(usdBuy("8", PEPE))
    expect(external.params).toMatchObject({ amount: "8", quoteAsset: "usdc" })
    expect(external.display.title).toBe("BUY 8 USDC (≈$8.00) → PEPE")
    // MOON pairs with SOL: the setting doesn't apply, and no quoteAsset is sent.
    const launched = await s.propose(usdBuy("6"))
    expect(launched.params).toEqual({ mint: MOON, side: "buy", amount: "0.04", clientTradeId: launched.opId })
    // A quoteAsset the trade names wins over the setting.
    expect((await s.propose(usdBuy("3", PEPE, { quoteAsset: "sol" }))).params).toMatchObject({ amount: "0.02", quoteAsset: "sol" })
  })

  test("a late approve converts again, at the new price", async () => {
    const s = await setup()
    const card = await s.propose(usdBuy("6"))
    s.tick(60_100)
    s.prices.set(SOL, 200)
    const result = await s.book.approve(VIEW, card.cardId, card.cardHash)
    expect(result.kind === "reproposed" && result.fresh.params.amount).toBe("0.03")
  })

  test("it's refused for a sell, beside an amount, when it isn't dollars, or when there's no price", async () => {
    const s = await setup()
    expect((await refusal(s.propose({ mint: MOON, side: "sell", amountUsd: "5" }))).message).toContain("buys only")
    expect((await refusal(s.propose(usdBuy("5", MOON, { amount: "1" })))).message).toContain("not both")
    for (const bad of ["-5", "0", "5.001", "five", 5.5e-7]) expect((await refusal(s.propose(usdBuy(bad)))).code).toBe("INVALID_TRADE")
    s.prices.delete(SOL)
    expect((await refusal(s.propose(usdBuy("5")))).code).toBe("NO_PRICE")
  })

  test("its limits are checked on the converted value", async () => {
    const s = await setup()
    // $11 of SOL plus the fee is over the $10 per-trade limit.
    const r = await refusal(s.propose(usdBuy("11")))
    expect(r.code).toBe("OVER_TRADE_LIMIT")
    // Without it, `buy $3` was refused as "$3.01" with no word on why the figure grew.
    expect(r.message).toMatch(/with Candle's [\d.]+% fee is more than \$10\.00 per trade/)
  })
})

describe("the compact card's parts", () => {
  const hashOf = (card: Card, tool = "candle_trade", kind: "trade" | "swap" = "trade") =>
    hashCard({ kind, tool, params: card.params, opId: card.opId, account: "acct_fake", agent: "momentum", wallet: WALLET, mode: "live" })

  test("a dollar buy leads with the dollars, and says what it gets and what it spends", async () => {
    const s = await setup()
    const card = await s.propose({ mint: MOON, side: "buy", amountUsd: "5" })
    expect(card.display.headline).toBe("BUY $5.00 of MOON")
    expect(card.display.spend).toEqual({ amount: 0.033333333, asset: "SOL" })
    expect(card.display.gets?.asset).toBe("MOON")
    expect(card.display.gets?.amount).toBeCloseTo(5 / 0.63, 1)
    expect(card.display.valueUsd).toBeCloseTo(5, 6)
    // Display isn't hashed: the hash is what runs, as before.
    expect(card.cardHash).toBe(hashOf(card))
  })

  test("a look-alike name carries its short address on the card, as everywhere else; a plain one doesn't", async () => {
    // "МOON" with a Cyrillic М reads as MOON: the card names it with its short address.
    const s = await setup({ resolve: { [PEPE]: market(PEPE, { metadata: { symbol: "МOON" } }) } })
    const card = await s.propose({ mint: PEPE, side: "buy", amountUsd: "5" })
    expect(card.display.headline).toBe("BUY $5.00 of МOON (Pepe…1111)")
    expect(card.display.title).toContain("МOON (Pepe…1111)")
    const plain = await s.propose({ mint: MOON, side: "buy", amountUsd: "5" })
    expect(plain.display.headline).toBe("BUY $5.00 of MOON")
  })

  test("a buy in an asset leads with the asset, and carries no spend figure", async () => {
    const s = await setup()
    const card = await s.propose(buy("0.05"))
    expect(card.display.headline).toBe("BUY 0.05 SOL of MOON")
    expect(card.display.spend).toBeUndefined()
    expect(card.display.valueUsd).toBeCloseTo(7.5, 6)
  })

  test("a percent sell says the percent, what it's estimated to sell, and what comes back", async () => {
    const s = await setup()
    const card = await s.propose({ mint: MOON, side: "sell", percent: 50 })
    expect(card.display.headline).toBe("SELL 50% of MOON")
    expect(card.display.sells?.asset).toBe("MOON")
    expect(card.display.gets?.asset).toBe("SOL")
    expect(card.cardHash).toBe(hashOf(card))
  })

  test("a swap says both assets", async () => {
    const s = await setup()
    const card = await s.propose({ from: "SOL", to: "USDC", amount: "0.04" }, { tool: "candle_swap" })
    expect(card.display.headline).toBe("SWAP 0.04 SOL → USDC")
    expect(card.display.gets?.asset).toBe("USDC")
  })

  test("the limits line shows only near a limit: from 80% of it", async () => {
    const s = await setup()
    // $7.54 of $10.00 per trade is under 80%.
    expect((await s.propose(buy("0.05"))).display.nearLimit).toBeUndefined()
    // 0.055 SOL is $8.25 plus the fee: over 80% of $10.00.
    expect((await s.propose(buy("0.055"))).display.nearLimit).toMatch(/^Candle Harness limit: \$8\.\d\d of \$10\.00 per trade/)
  })
})

describe("proposing", () => {
  test("a live buy becomes a card bound by hash, with an id the core minted, valued with Candle's fee", async () => {
    const s = await setup()
    const card = await s.propose({ ...buy("0.05"), clientTradeId: "agent-chose-this" }, { reason: "momentum\u001b[2J up" })
    expect(card).toMatchObject({ kind: "trade", tool: "candle_trade", idKey: "clientTradeId", state: "awaiting_approval", agent: "momentum", wallet: WALLET, mode: "live" })
    expect(card.opId).not.toBe("agent-chose-this")
    expect(card.opId).toMatch(/^[0-9a-f-]{36}$/)
    expect(card.params).toEqual({ mint: MOON, side: "buy", amount: "0.05", clientTradeId: card.opId })
    expect(card.cardHash).toBe(
      hashCard({ kind: "trade", tool: "candle_trade", params: card.params, opId: card.opId, account: "acct_fake", agent: "momentum", wallet: WALLET, mode: "live" }),
    )
    // 0.05 SOL at $150, plus Pro's 50 bps: $7.5375.
    expect(card.value.usd).toBeCloseTo(7.5375, 6)
    expect(card.display).toMatchObject({
      title: "BUY 0.05 SOL (≈$7.50) → MOON",
      price: "MOON $0.63",
      receives: "≈11.9 MOON, before fees and slippage",
      agent: "momentum",
      wallet: WALLET,
      mint: MOON,
      estimate: "≈$7.54",
      limits: "Candle Harness limit: $7.54 of $10.00 per trade · $7.54 of $50.00 today",
      candleKeyLimit: "Candle key limit: $100.00 daily (UTC day)",
      why: "momentum[2J up",
      mode: "live",
    })
    expect(card.expiresAt).toBe(new Date(T0 + 60_000).toISOString())
    expect(s.journal.rows().at(-1)).toMatchObject({ type: "card.created", mode: "live", agent: "momentum", cardId: card.cardId, opId: card.opId })
  })

  test("a Candle-launched token's buy spends its pair asset, and an amount in another asset is refused", async () => {
    const s = await setup({ resolve: { [MOON]: market(MOON, { quoteMint: USDC, quoteDecimals: 6 }) } })
    // Candle would ignore quoteAsset and spend 5 USDC, not 5 SOL: refused, saying what would work.
    const mismatch = await refusal(s.propose({ ...buy("5"), quoteAsset: "sol" }))
    expect(mismatch.code).toBe("PAIR_MISMATCH")
    expect(mismatch.message).toBe("MOON trades against USDC, not SOL. Buy it with USDC, or in dollars (buy $25 MOON).")
    expect((await s.propose({ ...buy("5"), quoteAsset: "usdc" })).display.title).toBe("BUY 5 USDC (≈$5.00) → MOON")
    const card = await s.propose(buy("4"))
    expect(card.display.title).toBe("BUY 4 USDC (≈$4.00) → MOON")
    expect(card.display.spends).toContain("USDC")
    expect(card.value.usd).toBeCloseTo(4.02, 6)
  })

  test("an external token's buy spends its quoteAsset, SOL when unset", async () => {
    const s = await setup()
    expect((await s.propose(buy("0.01", PEPE))).display.title).toBe("BUY 0.01 SOL (≈$1.50) → PEPE")
    expect((await s.propose({ ...buy("2", PEPE), quoteAsset: "usdc" })).display.title).toBe("BUY 2 USDC (≈$2.00) → PEPE")
  })

  test("prices are read when the card is proposed, and the card says when and by what", async () => {
    const s = await setup({ prices: { [SOL]: 150, [USDC]: 1, [PEPE]: 0.000123 } })
    const card = await s.propose(buy("0.05", PEPE))
    expect(card.display.price).toBe("PEPE $0.000123")
    expect(card.display.receives).toBe("≈60,976 PEPE, before fees and slippage")
    expect(card.display).toMatchObject({ pricedBy: "Candle market read", pricedAt: new Date(T0).toISOString() })
    expect(s.network).toContain("momentum:price SOL")
    expect(s.network).toContain(`momentum:price ${PEPE}`)
  })

  test("with no current price for what it spends, a dollar buy is refused rather than converted at an old price", async () => {
    const s = await setup({ prices: { [MOON]: 0.63 } })
    expect((await refusal(s.propose({ mint: MOON, side: "buy", amountUsd: "25" }))).code).toBe("NO_PRICE")
  })

  test("once Candle's quote tool is there, a buy shows what the quote says comes back, and the card says it was quoted", async () => {
    const asked: unknown[] = []
    const s = await setup({
      quote: (trade) => {
        asked.push(trade)
        return { amountOutRaw: "7936507", quoteAsset: "sol", quotedAt: T0 - 300, tokenRisks: [{ mint: MOON, kind: "transfer_fee", message: "x" }] }
      },
    })
    const card = await s.propose(buy("0.05"))
    expect(asked).toEqual([{ chain: "solana", mint: MOON, side: "buy", amountRaw: "50000000", quoteAsset: "sol" }])
    expect(card.display).toMatchObject({ receives: "≈7.937 MOON, Candle's quote before fees and slippage", pricedBy: "Candle quote", pricedAt: new Date(T0 - 300).toISOString(), risks: "transfer_fee" })
    // The quote prices the card; it never changes what runs.
    expect(card.params).toMatchObject({ mint: MOON, side: "buy", amount: "0.05" })
  })

  test("a quoted buy journals the quote's expected out, so a read-back buy's own can be capped by it", async () => {
    const s = await setup({ quote: () => ({ amountOutRaw: "7936507", quoteAsset: "sol", quotedAt: T0 - 300 }) })
    const card = await s.propose(buy("0.05"))
    expect(s.journal.rows().find((r) => r.type === "card.created" && r.cardId === card.cardId)).toMatchObject({ side: "buy", quoteOutRaw: "7936507" })
  })

  test("a quote that says the key can't use the embedded wallet refuses the card", async () => {
    const s = await setup({ quote: () => ({ amountOutRaw: "1", quotedAt: T0, payerPermitted: false }) })
    expect((await refusal(s.propose(buy("0.05")))).code).toBe("EMBEDDED_WALLET_NOT_PERMITTED")
  })

  test("a token with no price anywhere still gets a card, valued from what it spends", async () => {
    const s = await setup()
    const card = await s.propose(buy("0.05", PEPE))
    expect(card.display.price).toBeUndefined()
    expect(card.display.receives).toBeUndefined()
    expect(card.value.usd).toBeCloseTo(7.5375, 6)
  })

  test("a sell of a token Candle didn't launch pays out in its quoteAsset, never in its own pool's pair", async () => {
    // A new token whose only pool pairs it with some other token: Candle routes, the wallet gets SOL.
    const OTHER_PAIR = "PairFake11111111111111111111111111111111111"
    const s = await setup({ resolve: { [PEPE]: market(PEPE, { candleLaunched: false, external: true, quoteMint: OTHER_PAIR }) }, prices: { [SOL]: 150, [USDC]: 1, [PEPE]: 0.5 } })
    expect((await s.propose({ mint: PEPE, side: "sell", amount: "10" })).display.title).toBe("SELL 10 PEPE (≈$5.00) → SOL")
    expect((await s.propose({ mint: PEPE, side: "sell", amount: "10", quoteAsset: "usdc" })).display.title).toBe("SELL 10 PEPE (≈$5.00) → USDC")
    // And its buy spends SOL, routed to the token, rather than refusing for an unknown pair.
    expect((await s.propose(buy("0.01", PEPE))).display.title).toBe("BUY 0.01 SOL (≈$1.50) → PEPE")
  })

  test("a quoteAsset from the other chain is refused", async () => {
    const s = await setup()
    expect((await refusal(s.propose({ ...buy("1", PEPE), quoteAsset: "eth" }))).message).toContain('"sol", "usdc" or "cndl"')
  })

  test("a live percent sell sends the percent, and the card shows what it comes to now", async () => {
    const s = await setup()
    const card = await s.propose({ mint: MOON, side: "sell", percent: 50 })
    expect(card.params).toEqual({ mint: MOON, side: "sell", percent: 50, clientTradeId: card.opId })
    expect(card.display.title).toBe("SELL 50% · ≈6,172.83945 MOON (≈$3,888.89) → SOL")
    expect(card.display.receives).toBe("≈25.93 SOL, before fees and slippage")
    expect(card.value.usd).toBeCloseTo(6172.83945 * 0.63, 4)
  })

  test("a percent sell of a token Candle didn't launch is quoted from the raw amount the wallet holds", async () => {
    // Candle's market read has no decimals for a token it didn't launch, and live sells sized from it were refused.
    const asked: unknown[] = []
    const s = await setup({
      holdings: { [PEPE]: 554_327_460n },
      quote: (trade) => {
        asked.push(trade)
        return { amountOutRaw: "9879000", quoteAsset: "sol", quotedAt: T0 }
      },
    })
    const card = await s.propose({ mint: PEPE, side: "sell", percent: 100 })
    expect(card.params).toEqual({ mint: PEPE, side: "sell", percent: 100, clientTradeId: card.opId })
    expect(asked).toEqual([{ chain: "solana", mint: PEPE, side: "sell", amountRaw: "554327460", quoteAsset: "sol" }])
  })

  test("an amount sell of a token whose decimals Candle doesn't report is refused, saying to sell a percent", async () => {
    const s = await setup()
    const r = await refusal(s.propose({ mint: PEPE, side: "sell", amount: "10" }))
    expect(r.code).toBe("SELL_BY_PERCENT")
    expect(r.message).toBe("Candle can't sell an amount of PEPE yet, as it doesn't report this token's decimals. Sell a percent instead, such as: sell 100% PEPE. Nothing was sent.")
  })

  test("a percent sell of nothing is refused", async () => {
    const s = await setup({ holdings: {} })
    expect((await refusal(s.propose({ mint: MOON, side: "sell", percent: 100 }))).code).toBe("NOTHING_TO_SELL")
  })

  test("a swap is valued from what it spends, with no fee", async () => {
    const s = await setup()
    const card = await s.propose({ from: "SOL", to: "USDC", amount: "0.04" }, { tool: "candle_swap" })
    expect(card).toMatchObject({ kind: "swap", idKey: "clientSwapId", wallet: WALLET })
    expect(card.params).toEqual({ from: "SOL", to: "USDC", amount: "0.04", clientSwapId: card.opId })
    expect(card.value.usd).toBeCloseTo(6, 6)
    expect(card.display.title).toBe("SWAP 0.04 SOL (≈$6.00) → USDC")
    expect(card.display.receives).toBe("≈6 USDC, before slippage")
  })

  test("bad trade arguments are refused before anything is read", async () => {
    const s = await setup()
    for (const args of [
      { mint: MOON, side: "hold", amount: "1" },
      { mint: MOON, side: "buy" },
      { mint: MOON, side: "buy", amount: "1", percent: 10 },
      { mint: MOON, side: "buy", percent: 10 },
      { mint: MOON, side: "sell", percent: 150 },
      { mint: MOON, side: "buy", amount: "-1" },
      { mint: "", side: "buy", amount: "1" },
    ]) {
      expect((await refusal(s.propose(args))).code).toBe("INVALID_TRADE")
    }
    expect((await refusal(s.propose({ from: "SOL", to: "SOL", amount: "1" }, { tool: "candle_swap" }))).code).toBe("INVALID_SWAP")
    expect(s.network).toEqual([])
  })
})

describe("mints", () => {
  test("a mint Candle doesn't know is refused", async () => {
    const s = await setup()
    const r = await refusal(s.propose(buy("0.01", GHOST)))
    expect(r).toMatchObject({ code: "TOKEN_UNKNOWN", message: "Candle doesn't know this token." })
  })

  test("a token that can't trade now is refused as such; a failed check says try again, never unknown", async () => {
    const s = await setup({
      resolve: {
        [MOON]: market(MOON, { trade: { routable: false, reason: "solana_graduating" } }),
        [PEPE]: { kind: "error", code: "QUOTE_UNAVAILABLE", retryable: true, body: {} },
      },
    })
    expect((await refusal(s.propose(buy()))).message).toBe("This token isn't tradable on Candle right now.")
    const failed = await refusal(s.propose(buy("0.01", PEPE)))
    expect(failed.code).toBe("TOKEN_CHECK_FAILED")
    expect(failed.message).toContain("try again")
  })
})

describe("limits", () => {
  test("a buy over the per-trade limit is refused at proposal, with the numbers", async () => {
    const s = await setup()
    const r = await refusal(s.propose(buy("0.07")))
    expect(r.code).toBe("OVER_TRADE_LIMIT")
    expect(r.message).toContain("$10.55 with Candle's 0.5% fee is more than $10.00 per trade")
  })

  test("a burst of six cards whose sum crosses the day's limit: the sixth approve is refused", async () => {
    const s = await setup()
    const cards: Card[] = []
    // Six requests, each its own (an identical one from the agent is the same card).
    for (let i = 0; i < 6; i++) cards.push(await s.propose(buy(`0.060${i}`), { client: { ...HARNESS, clientId: `h${i}` } }))
    for (const card of cards.slice(0, 5)) await s.book.approve(VIEW, card.cardId, card.cardHash)
    const r = await refusal(s.book.approve(VIEW, cards[5]!.cardId, cards[5]!.cardHash))
    expect(r.code).toBe("OVER_DAY_LIMIT")
    expect(s.executed).toHaveLength(5)
    // And a new one is refused at proposal.
    expect((await refusal(s.propose(buy("0.06"), { client: { ...HARNESS, clientId: "h9" } }))).code).toBe("OVER_DAY_LIMIT")
  })

  test("each agent's day limit counts only its own trades", async () => {
    const s = await setup()
    s.spend.record("earlier", "momentum", 49, T0)
    expect((await refusal(s.propose(buy("0.01")))).code).toBe("OVER_DAY_LIMIT")
    const swing = await s.propose(buy("0.01"), { client: { ...HARNESS, agent: "swing" } })
    expect(swing.agent).toBe("swing")
  })

  test("a sell over the limit runs", async () => {
    const s = await setup()
    const card = await s.propose({ mint: MOON, side: "sell", amount: "10000" })
    expect(card.value.usd).toBeCloseTo(6300, 6)
    await s.book.approve(VIEW, card.cardId, card.cardHash)
    expect(s.executed).toHaveLength(1)
  })

  test("with no price, the card says so and Candle's key limit is the only limit: no silent zero", async () => {
    const s = await setup({ prices: {} })
    const card = await s.propose(buy("5"))
    expect(card.value).toEqual({ unvalued: true })
    expect(card.display.estimate).toBe("no price")
    expect(card.display.limits).toContain("no price, so it can't be checked")
    expect(card.display.candleKeyLimit).toBe("Candle key limit: $100.00 daily (UTC day)")
  })
})

describe("approving", () => {
  test("one press, no network call: the card runs through its own agent", async () => {
    const s = await setup()
    const card = await s.propose(buy())
    s.blockNetwork()
    const result = await s.book.approve(VIEW, card.cardId, card.cardHash)
    expect(result.kind).toBe("submitted")
    expect(s.executed.map((c) => c.agent)).toEqual(["momentum"])
    const rows = s.journal.rows().map((r) => r.type)
    expect(rows.slice(-1)).toEqual(["card.approved"])
    expect(s.journal.rows().at(-1)).toMatchObject({ cardHash: card.cardHash, opId: card.opId, agent: "momentum", side: "buy", how: "view" })
  })

  test("the journal and the card say how it was approved, and a view can't claim instant", async () => {
    const s = await setup()
    const cases = [["enter", "enter"], ["click", "click"], ["instant", "instant"], ["robot", "view"], [undefined, "view"]] as const
    for (const [i, [given, recorded]] of cases.entries()) {
      const card = await s.propose(buy(`0.00${i + 1}`))
      const result = await s.book.approve(VIEW, card.cardId, card.cardHash, given)
      expect(result.kind === "submitted" && result.card.approvedHow).toBe(recorded)
      expect(s.journal.rows().findLast((r) => r.type === "card.approved")).toMatchObject({ cardId: card.cardId, how: recorded })
    }
  })

  test("an approve at 59.9 s runs", async () => {
    const s = await setup()
    const card = await s.propose(buy())
    s.tick(59_900)
    expect((await s.book.approve(VIEW, card.cardId, card.cardHash)).kind).toBe("submitted")
    expect(s.executed).toHaveLength(1)
  })

  test("an approve at 60.1 s proposes a fresh card at the current price, and the old one never runs", async () => {
    const s = await setup()
    const card = await s.propose(buy())
    s.tick(60_100)
    s.prices.set(SOL, 160)
    const result = await s.book.approve(VIEW, card.cardId, card.cardHash)
    expect(result.kind).toBe("reproposed")
    if (result.kind !== "reproposed") return
    expect(result.expired.state).toBe("expired")
    expect(result.fresh.opId).not.toBe(card.opId)
    expect(result.fresh.cardHash).not.toBe(card.cardHash)
    expect(result.fresh.value.usd).toBeCloseTo(0.05 * 160 * 1.005, 6)
    expect(result.fresh.state).toBe("awaiting_approval")
    expect(s.executed).toEqual([])
    // Approving the old one again never runs it either.
    expect((await refusal(s.book.approve(VIEW, card.cardId, card.cardHash))).code).toBe("CARD_NOT_AWAITING")
  })

  test("re-quoting an expired card proposes a fresh one at the current price; an open card can't be re-quoted", async () => {
    const s = await setup()
    const card = await s.propose(buy())
    expect((await refusal(s.book.requote(VIEW, card.cardId))).code).toBe("CARD_NOT_EXPIRED")
    s.tick(60_000)
    await s.book.expireDue()
    s.prices.set(SOL, 160)
    const fresh = await s.book.requote(VIEW, card.cardId)
    expect(fresh.opId).not.toBe(card.opId)
    expect(fresh.state).toBe("awaiting_approval")
    expect(fresh.agent).toBe(card.agent)
    expect(fresh.value.usd).toBeCloseTo(0.05 * 160 * 1.005, 6)
    expect(s.executed).toEqual([])
    expect((await refusal(s.book.requote(VIEW, "nope"))).code).toBe("CARD_NOT_FOUND")
  })

  test("only a trade or a swap is paid from another wallet", async () => {
    const s = await setup()
    const card = await s.propose({ keyPrefix: "momeAb3d", walletIds: [] }, { tool: "candle_set_profile_wallets" })
    expect((await refusal(s.book.requote(VIEW, card.cardId, { wallet: "embedded" }))).code).toBe("WALLET_FIXED")
  })

  test("a kept sell approved while its fresh card was being made leaves no second sell open, and isn't listed as kept", async () => {
    const s = await setup()
    const sell = await s.propose({ mint: MOON, side: "sell", percent: 50 })
    const real = s.book.propose.bind(s.book)
    s.book.propose = async (input) => {
      if (input.replaces === sell.cardId) await s.book.approve(VIEW, sell.cardId, sell.cardHash)
      return real(input)
    }
    const kept = await s.book.refreshWhere((c) => c.side === "sell", "kill_switch_fresh")
    expect(kept).toEqual([])
    expect(s.book.get(sell.cardId)!.state).toBe("approved")
    expect(s.book.list().filter((c) => c.state === "awaiting_approval")).toEqual([])
    expect(s.executed.map((c) => c.cardId)).toEqual([sell.cardId])
  })

  test("a card that expires while its approval is running still runs: the press was in time", async () => {
    const s = await setup()
    const card = await s.propose(buy())
    s.tick(59_900)
    const hold = s.holdExecution()
    const approving = s.book.approve(VIEW, card.cardId, card.cardHash)
    await Bun.sleep(5)
    s.tick(5_000)
    await s.book.expireDue()
    expect(s.book.held(card.opId)!.state).toBe("approved")
    // A second press while it runs is refused, and says why.
    expect((await refusal(s.book.approve(VIEW, card.cardId, card.cardHash))).message).toContain("being approved")
    hold.open()
    expect((await approving).kind).toBe("submitted")
  })

  test("the sweep never expires a card while its approval is being written", async () => {
    const s = await setup()
    const card = await s.propose(buy())
    s.tick(59_900)
    // Hold the card.approved row's write open: that's the window the sweep must keep out of.
    const append = s.journal.append.bind(s.journal)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    s.journal.append = async (row) => {
      if (row.type === "card.approved") await gate
      return append(row)
    }
    const approving = s.book.approve(VIEW, card.cardId, card.cardHash)
    await Bun.sleep(5)
    s.tick(5_000)
    await s.book.expireDue()
    release()
    expect((await approving).kind).toBe("submitted")
    expect(s.journal.rows().some((r) => r.type === "card.expired")).toBe(false)
  })

  test("a stale hash is refused", async () => {
    const s = await setup()
    const card = await s.propose(buy())
    expect((await refusal(s.book.approve(VIEW, card.cardId, "0".repeat(64)))).code).toBe("CARD_HASH_MISMATCH")
    expect(s.executed).toEqual([])
  })

  test("a mode change between propose and approve is refused", async () => {
    const s = await setup()
    const card = await s.propose(buy())
    s.setMode("paper")
    expect((await refusal(s.book.approve(VIEW, card.cardId, card.cardHash))).code).toBe("CARD_CHANGED")
    expect(s.executed).toEqual([])
  })

  test("changing a card's agent breaks its hash", async () => {
    const s = await setup()
    const card = await s.propose(buy())
    ;(s.book.held(card.opId) as { agent: string }).agent = "swing"
    expect((await refusal(s.book.approve(VIEW, card.cardId, card.cardHash))).code).toBe("CARD_CHANGED")
    expect(s.executed).toEqual([])
  })

  test("an approval whose operation couldn't be written gives the day's spend back", async () => {
    const s = await setup({ executeThrows: true })
    const card = await s.propose(buy())
    await expect(s.book.approve(VIEW, card.cardId, card.cardHash)).rejects.toThrow("disk full")
    expect(s.spend.spent("momentum", s.now())).toBe(0)
  })

  test("an approval whose paused refusal couldn't be written gives the day's spend back", async () => {
    const s = await setup({ refusePausedThrows: true })
    const card = await s.propose(buy())
    await expect(s.book.approve(VIEW, card.cardId, card.cardHash)).rejects.toThrow("disk full")
    expect(s.spend.spent("momentum", s.now())).toBe(0)
    expect(s.executed).toEqual([])
  })

  test("paused for buys: a buy or swap is refused at proposal and at approve; a sell runs", async () => {
    const s = await setup()
    const card = await s.propose(buy())
    s.setPaused(true)
    expect((await refusal(s.book.approve(VIEW, card.cardId, card.cardHash))).code).toBe("PAUSED")
    expect((await refusal(s.propose(buy("0.01")))).code).toBe("PAUSED")
    const sell = await s.propose({ mint: MOON, side: "sell", amount: "1" })
    await s.book.approve(VIEW, sell.cardId, sell.cardHash)
    expect(s.executed.map((c) => c.cardId)).toEqual([sell.cardId])
  })

  test("an unknown tool's card can only be rejected", async () => {
    const s = await setup()
    const card = await s.propose({ x: 1 }, { tool: "candle_future_tool" })
    expect(card.display.supported).toBe(false)
    expect((await refusal(s.book.approve(VIEW, card.cardId, card.cardHash))).code).toBe("NOT_SUPPORTED")
    expect((await s.book.reject(VIEW, card.cardId)).state).toBe("rejected")
  })

  test("narrowing a key's wallets is a card with no value and no limit", async () => {
    const s = await setup()
    const card = await s.propose({ keyPrefix: "momeAb3d", walletIds: [] }, { tool: "candle_set_profile_wallets" })
    expect(card).toMatchObject({ kind: "lessaccess", wallet: "none", value: { unvalued: true } })
    await s.book.approve(VIEW, card.cardId, card.cardHash)
    expect(s.executed).toHaveLength(1)
  })
})

describe("wallets", () => {
  test("an agent whose key isn't allowed the embedded wallet gets no live card, and is told the owner's command", async () => {
    const s = await setup({ statuses: { momentum: status({ embeddedWallet: "denied" }) } })
    const r = await refusal(s.propose(buy()))
    expect(r.code).toBe("EMBEDDED_WALLET_NOT_PERMITTED")
    expect(r.message).toContain("candle keys update momeAb3d --embedded-wallet allow")
    expect(r.message).not.toContain("own terminal")
  })

  test("an agent whose wallet can't be read gets no card: the hash needs the paying wallet", async () => {
    const s = await setup({ statuses: {} })
    expect((await refusal(s.propose(buy()))).code).toBe("AGENT_STATUS_UNKNOWN")
  })

  test("a sell card shows the wallet's shared holding and who shares it", async () => {
    const s = await setup()
    const card = await s.propose({ mint: MOON, side: "sell", percent: 100 })
    expect(card.display.sharedWith).toEqual(["swing"])
  })
})

describe("the queue", () => {
  test("the same request from the same client while its card is open is that card", async () => {
    const s = await setup()
    const a = await s.propose(buy())
    const b = await s.propose(buy())
    expect(b.cardId).toBe(a.cardId)
  })

  test("an agent's harness reattaching mid-turn is the same proposer: an identical request is the same card", async () => {
    const s = await setup()
    const a = await s.propose(buy())
    const b = await s.propose(buy(), { client: { ...HARNESS, clientId: "h2" } })
    expect(b.cardId).toBe(a.cardId)
    // A view typing the same trade is its own proposer.
    const typed = await s.propose(buy(), { client: { clientId: VIEW, role: "view", agent: "momentum" } })
    expect(typed.cardId).not.toBe(a.cardId)
  })

  test("a client may hold 5 open cards", async () => {
    const s = await setup()
    for (let i = 1; i <= 5; i++) await s.propose(buy(`0.0${i}`))
    expect((await refusal(s.propose(buy("0.06")))).code).toBe("TOO_MANY_OPEN_CARDS")
    expect((await s.propose(buy("0.06"), { client: { ...HARNESS, clientId: "h2" } })).state).toBe("awaiting_approval")
  })

  test("cards expire at 60 s on the sweep, with or without a view", async () => {
    const s = await setup()
    const card = await s.propose(buy())
    s.tick(59_999)
    await s.book.expireDue()
    expect(s.book.held(card.opId)!.state).toBe("awaiting_approval")
    s.tick(1)
    await s.book.expireDue()
    expect(s.book.held(card.opId)!.state).toBe("expired")
    expect(s.journal.rows().at(-1)).toMatchObject({ type: "card.expired", cardId: card.cardId, reason: "expiresAt" })
  })

  test("a restart expires the open cards it finds in the journal, and says why", async () => {
    const s = await setup()
    const open = await s.propose(buy())
    const approved = await s.propose(buy("0.02"))
    await s.book.approve(VIEW, approved.cardId, approved.cardHash)
    const rebuilt = await setup()
    const expired = await rebuilt.book.expireAfterRestart(s.journal.rows())
    expect(expired).toEqual([open.cardId])
    expect(rebuilt.journal.rows().at(-1)).toMatchObject({ type: "card.expired", cardId: open.cardId, reason: "core_restarted" })
  })

  test("withdraw takes back the proposer's own card; another client's answers as missing", async () => {
    const s = await setup()
    const card = await s.propose(buy())
    expect((await refusal(s.book.withdraw("someone-else", card.cardId))).code).toBe("CARD_NOT_FOUND")
    expect((await s.book.withdraw("h1", card.cardId)).state).toBe("withdrawn")
  })
})

// Candle's MCP card tools from the embedded wallet: launches, staking, claims, profile edits and posts.
// Pins paper, the kill switch, limits, public things, and launch images by URL only.
describe("Candle's MCP card tools", () => {
  const IMAGE = "https://cdn.example/fake-logo.png"
  // docs.candle.tv/developers/headless-launch, "Dry run": the API's body as candle_launch_token relays it.
  const dryRunBody = {
    success: true,
    dryRun: true,
    launchWallet: WALLET,
    resolved: { chain: "solana", quoteAsset: "sol", mode: "open", buyAmount: "0" },
    curveTerms: { symbol: "SOL", thresholdRaw: "80000000000", raise: 80, firstBuy: { basis: "buyAmount", supplyPct: 1.25 } },
    devBuyMax: "500000000",
  }
  const launchDryRun = (): ToolOutcome => ({ kind: "ok", result: dryRunBody })
  // candle_launch_and_seed wraps it (agentic orchestrate.ts, executeLaunchAndSeed).
  const seedDryRun: ToolOutcome = { kind: "ok", result: { clientLaunchId: "x", dryRun: true, api: dryRunBody } }
  const stakeDryRun = (action: string, extra: Record<string, unknown> = {}): ToolOutcome => ({
    kind: "ok",
    result: { success: true, dryRun: true, action, payer: "main", wallet: WALLET, clientStakeId: "x", amountRaw: "100000000", figures: { requiredLamports: "2039280" }, ...extra },
  })
  const staking: ToolOutcome = {
    kind: "ok",
    result: {
      success: true,
      pool: { withdrawalTimelockSeconds: 604_800, paused: false, maxActiveWithdrawals: 10 },
      wallets: [
        {
          payer: "main",
          address: WALLET,
          cndl: { mint: "CndlFake", decimals: 6, amountRaw: "500000000" },
          staked: { mint: "SCndlFake", decimals: 6, amountRaw: "250000000", cndlValueRaw: "260000000" },
          pendingWithdrawalRaw: "0",
          withdrawals: { active: [{ withdrawal: "WdFake1", amountRaw: "40000000", startTime: "", endTime: "", claimable: true }], finished: [] },
          unclaimedRewards: [{ rewardId: "rw_fake_1", mint: "CndlFake", symbol: "CNDL", name: "Candle", amountRaw: "12500000", distributedAt: null, claiming: false }],
        },
      ],
      notes: [],
    },
  }
  const feeDryRun = (claimable: boolean): ToolOutcome => ({
    kind: "ok",
    result: {
      success: true,
      mint: MOON,
      chain: "solana",
      dryRun: true,
      recipient: WALLET,
      claimable,
      ...(claimable ? {} : { reason: "below_dust" }),
      claimed: claimable ? [{ symbol: "SOL", mint: SOL, decimals: 9, amountRaw: "1250000", txHash: null }] : [],
      remaining: [],
      warnings: [],
    },
  })
  const scripted = (answers: Record<string, ToolOutcome>) => (tool: string, args: Record<string, unknown>) => answers[args.dryRun === true ? `${tool}:dry` : tool] ?? { kind: "error" as const, code: "UNSCRIPTED", retryable: false, body: {} }
  const launch = (extra: Record<string, unknown> = {}) => ({ name: "Fake Moon", symbol: "FMOON", imageUrl: IMAGE, ...extra })

  describe("launches", () => {
    test("the dry run goes first, as the same call under the card's own id with dryRun: true; the card runs it with dryRun: false", async () => {
      const s = await setup({ candle: scripted({ "candle_launch_token:dry": launchDryRun() }) })
      const card = await s.propose(launch({ clientLaunchId: "agent-picked", dryRun: false }), { tool: "candle_launch_token", reason: "the meme of the week" })
      expect(s.candleCalls).toEqual([{ agent: "momentum", tool: "candle_launch_token", args: { name: "Fake Moon", symbol: "FMOON", imageUrl: IMAGE, clientLaunchId: card.opId, dryRun: true } }])
      expect(card.kind).toBe("launch")
      expect(card.params).toEqual({ name: "Fake Moon", symbol: "FMOON", imageUrl: IMAGE, clientLaunchId: card.opId, dryRun: false })
      expect(card.opId).not.toBe("agent-picked")
      expect(card.wallet).toBe(WALLET)
      expect(card.side).toBeUndefined()
      expect(card.display.headline).toBe("LAUNCH FMOON")
      expect(card.display.publicNote).toContain("can't be taken back")
      expect(card.display.preview).toContain("raises 80 SOL to graduate")
      expect(card.cardHash).toBe(hashCard({ kind: "launch", tool: "candle_launch_token", params: card.params, opId: card.opId, account: "acct_fake", agent: "momentum", wallet: WALLET, mode: "live" }))
    })

    test("a local image file is refused before anything is sent (by URL only)", async () => {
      for (const field of ["imagePath", "bannerPath"]) {
        const s = await setup({ candle: scripted({ "candle_launch_token:dry": launchDryRun() }) })
        const out = await refusal(s.propose(launch({ [field]: "/tmp/logo.png" }), { tool: "candle_launch_token" }))
        expect(out.code).toBe("IMAGE_BY_URL")
        expect(out.message).toContain("image upload")
        expect(s.candleCalls).toEqual([])
      }
    })

    test("a dry run Candle refuses makes no card, and says why in Candle's words", async () => {
      const s = await setup({ candle: scripted({ "candle_launch_token:dry": { kind: "error", code: "INVALID_SYMBOL", retryable: false, body: { success: false, error: { code: "INVALID_SYMBOL", message: "symbol exceeds 10 UTF-8 bytes" } } } }) })
      const out = await refusal(s.propose(launch({ symbol: "WAYTOOLONGSYMBOL" }), { tool: "candle_launch_token" }))
      expect(out.code).toBe("INVALID_SYMBOL")
      expect(out.message).toContain("symbol exceeds 10 UTF-8 bytes")
      expect(s.book.list()).toEqual([])
      expect(s.journal.rows().filter((r) => r.type === "card.refused").map((r) => r.code)).toEqual(["INVALID_SYMBOL"])
    })

    test("a dry run nobody answered makes no card either", async () => {
      const s = await setup({ candle: () => ({ kind: "lost", reason: "timeout" }) })
      const out = await refusal(s.propose(launch(), { tool: "candle_launch_token" }))
      expect(out.code).toBe("DRY_RUN_NO_ANSWER")
      expect(s.book.list()).toEqual([])
    })

    test("a seed is a buy: valued at the price now, held to the Candle Harness limits with the numbers, and the card names the ceiling and the launch cap", async () => {
      const s = await setup({ statuses: { momentum: status({ dailyLaunchCap: 50 }) }, candle: scripted({ "candle_launch_and_seed:dry": seedDryRun }) })
      const card = await s.propose(launch({ devBuy: "0.05" }), { tool: "candle_launch_and_seed" })
      expect(card).toMatchObject({ side: "buy", value: { usd: 7.5, unvalued: false } })
      expect(card.display.headline).toBe("LAUNCH FMOON · seed 0.05 SOL")
      expect(card.display.spend).toEqual({ amount: 0.05, asset: "SOL" })
      expect(card.display.preview).toContain("dev-buy ceiling 0.5 SOL")
      expect(card.display.preview).toContain("50 launches a day, shared by every key on the account")
      // $15 of SOL is over the $10 per-trade limit: refused when proposed, with the figures.
      const over = await refusal(s.propose(launch({ devBuy: "0.1", symbol: "FMOON2" }), { tool: "candle_launch_and_seed" }))
      expect(over.code).toBe("OVER_TRADE_LIMIT")
      expect(over.message).toContain("$15.00")
    })

    test("candle_launch_token's buyAmount is raw units of the quote asset, valued the same way", async () => {
      const s = await setup({ candle: scripted({ "candle_launch_token:dry": launchDryRun() }) })
      const card = await s.propose(launch({ buyAmount: "50000000" }), { tool: "candle_launch_token" })
      expect(card).toMatchObject({ side: "buy", value: { usd: 7.5, unvalued: false } })
    })

    test("approving a launch makes no network call, and a paused core refuses it then too", async () => {
      const s = await setup({ candle: scripted({ "candle_launch_token:dry": launchDryRun() }) })
      const card = await s.propose(launch(), { tool: "candle_launch_token" })
      s.blockNetwork()
      s.setPaused(true)
      const paused = await refusal(s.book.approve(VIEW, card.cardId, card.cardHash, "enter"))
      expect(paused.code).toBe("PAUSED")
      expect(paused.message).toContain("Launch")
      s.setPaused(false)
      const out = await s.book.approve(VIEW, card.cardId, card.cardHash, "enter")
      expect(out.kind).toBe("submitted")
      expect(s.executed.map((c) => c.params.dryRun)).toEqual([false])
    })
  })

  describe("staking", () => {
    test("payer is main: left out it's main, and the dry run goes first under the card's id", async () => {
      const s = await setup({ candle: scripted({ "candle_stake:dry": stakeDryRun("stake"), candle_get_staking: staking }) })
      const card = await s.propose({ amountRaw: "100000000", clientStakeId: "agent-picked" }, { tool: "candle_stake" })
      expect(card.params).toEqual({ payer: "main", amountRaw: "100000000", clientStakeId: card.opId, dryRun: false })
      expect(s.candleCalls.find((c) => c.tool === "candle_stake")!.args).toEqual({ payer: "main", amountRaw: "100000000", clientStakeId: card.opId, dryRun: true })
      expect(card.display.headline).toBe("STAKE 100 CNDL")
      expect(card.display.preview).toContain("pool wait 7 days")
      expect(card.wallet).toBe(WALLET)
      // Staking isn't limited: the CNDL stays in the wallet as sCNDL.
      expect(card.side).toBeUndefined()
    })

    test("a linked or TEE payer is refused, never moved to the embedded wallet: a TEE wallet stakes through the CLI", async () => {
      for (const args of [{ payer: "linked", linkedWalletId: "tee_1", amountRaw: "1" }, { linkedWalletId: "tee_1", amountRaw: "1" }]) {
        const s = await setup({ candle: scripted({ "candle_stake:dry": stakeDryRun("stake"), candle_get_staking: staking }) })
        const out = await refusal(s.propose(args, { tool: "candle_stake" }))
        expect(out.code).toBe("STAKE_FROM_EMBEDDED")
        expect(s.candleCalls).toEqual([])
      }
    })

    test("an unstake is in sCNDL at the read's decimals, and finishing names its withdrawal", async () => {
      const s = await setup({ candle: scripted({ "candle_unstake:dry": stakeDryRun("unstake", { amountRaw: "25000000" }), "candle_finish_unstake:dry": stakeDryRun("finish", { withdrawal: "WdFake1" }), candle_get_staking: staking }) })
      const unstake = await s.propose({ amountRaw: "25000000" }, { tool: "candle_unstake" })
      expect(unstake.display.headline).toBe("UNSTAKE 25 sCNDL")
      const finish = await s.propose({ withdrawal: "WdFake1" }, { tool: "candle_finish_unstake" })
      expect(finish.params).toEqual({ payer: "main", withdrawal: "WdFake1", clientStakeId: finish.opId, dryRun: false })
      expect(finish.display.headline).toBe("FINISH UNSTAKE · 40 CNDL")
    })

    test("a dry run Candle refuses makes no card", async () => {
      const s = await setup({ candle: scripted({ "candle_stake:dry": { kind: "error", code: "INSUFFICIENT_BALANCE", retryable: false, body: { success: false, error: { code: "INSUFFICIENT_BALANCE", message: "Not enough CNDL" } } }, candle_get_staking: staking }) })
      expect((await refusal(s.propose({ amountRaw: "999999999999" }, { tool: "candle_stake" }))).code).toBe("INSUFFICIENT_BALANCE")
      expect(s.book.list()).toEqual([])
    })
  })

  describe("claims", () => {
    test("a fee claim dry-runs first and shows what it would pay, and to whom", async () => {
      const s = await setup({ candle: scripted({ "candle_claim_fees:dry": feeDryRun(true) }) })
      const card = await s.propose({ mint: MOON, dryRun: false }, { tool: "candle_claim_fees" })
      expect(s.candleCalls).toEqual([{ agent: "momentum", tool: "candle_claim_fees", args: { mint: MOON, dryRun: true } }])
      expect(card.params).toEqual({ mint: MOON, dryRun: false })
      expect(card.kind).toBe("claim")
      expect(card.display.preview).toContain("0.00125 SOL")
      expect(card.display.preview).toContain("Wall…1111")
    })

    test("a fee claim the dry run says isn't claimable makes no card, with Candle's reason", async () => {
      const s = await setup({ candle: scripted({ "candle_claim_fees:dry": feeDryRun(false) }) })
      const out = await refusal(s.propose({ mint: MOON }, { tool: "candle_claim_fees" }))
      expect(out.code).toBe("FEE_NOT_CLAIMABLE")
      expect(out.message).toContain("below_dust")
    })

    test("a staking reward claim has no dry run: the card reads the reward from the staking read", async () => {
      const s = await setup({ candle: scripted({ candle_get_staking: staking }) })
      const card = await s.propose({ rewardId: "rw_fake_1" }, { tool: "candle_claim_staking_reward" })
      expect(card.params).toEqual({ rewardId: "rw_fake_1" })
      expect(card.display.headline).toBe("CLAIM REWARD · 12.5 CNDL")
      expect(s.candleCalls.map((c) => c.tool)).toEqual(["candle_get_staking"])
      const s2 = await setup({ candle: scripted({ candle_get_staking: staking }) })
      expect((await refusal(s2.propose({ rewardId: "rw_missing" }, { tool: "candle_claim_staking_reward" }))).code).toBe("REWARD_NOT_FOUND")
    })
  })

  describe("profile edits and posts", () => {
    test("a post is a public card: its text, that it's public, that a re-send can post twice; nothing read when proposed", async () => {
      const s = await setup()
      const card = await s.propose({ text: "gm from the fake desk" }, { tool: "candle_create_post" })
      expect(card).toMatchObject({ kind: "public", params: { text: "gm from the fake desk" }, wallet: "none" })
      expect(card.display.headline).toBe("POST")
      expect(card.display.preview).toBe("gm from the fake desk")
      expect(card.display.publicNote).toContain("public")
      expect(card.display.resendNote).toContain("twice")
      expect(s.candleCalls).toEqual([])
    })

    test("a profile edit names the fields it changes, and the shared daily edits", async () => {
      const s = await setup()
      const card = await s.propose({ publicThesis: "fast in, faster out", publicLinks: { x: null } }, { tool: "candle_update_profile" })
      expect(card.display.headline).toBe("PROFILE EDIT · bio, links")
      expect(card.display.publicNote).toContain("20 edits a day")
    })

    test("a profile image (server 0.10.25) names avatar or banner and its address, that it's published, and that a failed fetch still uses an edit", async () => {
      const s = await setup()
      const card = await s.propose({ kind: "banner", imageUrl: "https://example.com/wide.png" }, { tool: "candle_upload_profile_image" })
      expect(card).toMatchObject({ kind: "public", params: { kind: "banner", imageUrl: "https://example.com/wide.png" }, wallet: "none" })
      expect(card.display.headline).toBe("PROFILE IMAGE · banner")
      expect(card.display.preview).toBe("https://example.com/wide.png")
      expect(card.display.publicNote).toContain("uploads.candle.tv")
      expect(card.display.publicNote).toContain("even if the fetch fails")
      expect(s.candleCalls).toEqual([])
      for (const bad of [{ kind: "avatar", imageUrl: "http://example.com/a.png" }, { kind: "avatar", imageUrl: "./a.png" }, { kind: "icon", imageUrl: "https://example.com/a.png" }]) {
        expect((await refusal(s.propose(bad, { tool: "candle_upload_profile_image" }))).code).toBe("INVALID_POST")
      }
    })

    test("a token edit (server 0.10.28) names the token and each field it changes, that it's public, and that a re-send changes nothing", async () => {
      const s = await setup()
      const card = await s.propose({ chain: "solana", mint: MOON, description: "Fresh words", socials: { twitter: "https://x.com/moon", website: "" } }, { tool: "candle_token_edit" })
      expect(card).toMatchObject({ kind: "public", wallet: "none" })
      expect(card.display.headline).toBe("TOKEN EDIT · description, X, website")
      expect(card.display.preview).toBe("description: Fresh words · X: https://x.com/moon · website: removed")
      expect(card.display.publicNote).toContain("Only the account that launched it")
      expect(card.display.resendNote).toContain("changes nothing")
      expect(s.candleCalls).toEqual([])
      for (const bad of [{ chain: "solana", mint: MOON }, { chain: "eth", mint: MOON, description: "x" }, { chain: "solana", description: "x" }]) {
        expect((await refusal(s.propose(bad, { tool: "candle_token_edit" }))).code).toBe("INVALID_POST")
      }
    })

    test("deleting a post says it still counts toward the day's 30", async () => {
      const s = await setup()
      const card = await s.propose({ postId: "post_fake_1" }, { tool: "candle_delete_post" })
      expect(card.display.headline).toBe("DELETE POST")
      expect(card.display.publicNote).toContain("30")
    })
  })

  describe("paper and the kill switch", () => {
    test("paused, launches, stakes, profile edits and new posts are refused when proposed, before anything is read", async () => {
      const cases: [string, Record<string, unknown>][] = [
        ["candle_launch_token", launch()],
        ["candle_launch_and_seed", launch()],
        ["candle_stake", { amountRaw: "1" }],
        ["candle_update_profile", { publicThesis: "x" }],
        ["candle_upload_profile_image", { kind: "avatar", imageUrl: "https://example.com/a.png" }],
        ["candle_create_post", { text: "x" }],
        ["candle_token_edit", { chain: "solana", mint: MOON, description: "x" }],
      ]
      for (const [tool, args] of cases) {
        const s = await setup({ candle: scripted({}) })
        s.setPaused(true)
        expect(`${tool}: ${(await refusal(s.propose(args, { tool }))).code}`).toBe(`${tool}: PAUSED`)
        expect(s.candleCalls).toEqual([])
      }
    })

    test("paused, unstakes, finishes, claims and post deletes are still proposed", async () => {
      const s = await setup({ candle: scripted({ "candle_unstake:dry": stakeDryRun("unstake"), "candle_finish_unstake:dry": stakeDryRun("finish"), "candle_claim_fees:dry": feeDryRun(true), candle_get_staking: staking }) })
      s.setPaused(true)
      await s.propose({ amountRaw: "1" }, { tool: "candle_unstake" })
      await s.propose({ withdrawal: "WdFake1" }, { tool: "candle_finish_unstake" })
      await s.propose({ mint: MOON }, { tool: "candle_claim_fees" })
      await s.propose({ rewardId: "rw_fake_1" }, { tool: "candle_claim_staking_reward" })
      await s.propose({ postId: "p1" }, { tool: "candle_delete_post" })
      expect(s.book.list()).toHaveLength(5)
    })
  })

  // Only buys, sells and swaps run without a card.
  describe("on a wallet that trades inside limits", () => {
    test("a launch with a seed and a stake are cards all the same, at a value its figures would take", async () => {
      const s = await setup({ candle: scripted({ "candle_launch_and_seed:dry": seedDryRun, "candle_stake:dry": stakeDryRun("stake"), candle_get_staking: staking }) })
      s.setWallet(WALLET, { setting: "inside", perTradeUsd: 10, perDayUsd: 50 })
      const seeded = await s.propose(launch({ devBuy: "0.05" }), { tool: "candle_launch_and_seed" })
      expect(seeded).toMatchObject({ side: "buy", wallet: WALLET, value: { usd: 7.5 } })
      const staked = await s.propose({ amountRaw: "100000000" }, { tool: "candle_stake" })
      for (const card of [seeded, staked]) {
        const out = await s.book.runWithoutCard(card, HARNESS)
        expect(out.ran).toBeUndefined()
        expect(out.card.state).toBe("awaiting_approval")
        expect(out.card.cardBecause).toBeUndefined()
      }
      expect(s.executed).toHaveLength(0)
    })
  })
})

// Candle's cap held, Candle's per-asset cap, and a wallet's spend without a card.
describe("a key Candle refused for its cap", () => {
  const swap = { from: "SOL", to: "USDC", amount: "0.05" }

  test("its buys and swaps are refused in Candle's words before any read; its sells still go; another key is free", async () => {
    const s = await setup()
    s.holds.note("momentum", { code: "KEY_LIMIT_REACHED", resetsAt: T0 + 3_600_000 }, T0)
    const before = s.network.length
    const bought = await refusal(s.propose(buy()))
    expect(bought.code).toBe("KEY_LIMIT_REACHED")
    expect(bought.message).toContain("Sells still go. Nothing was sent.")
    expect(s.network.length).toBe(before)
    expect((await refusal(s.propose(swap, { tool: "candle_swap" }))).code).toBe("KEY_LIMIT_REACHED")
    expect((await s.propose({ mint: MOON, side: "sell", percent: 50 })).state).toBe("awaiting_approval")
    expect((await s.propose(buy(), { client: { clientId: "h2", role: "harness", agent: "swing" } })).state).toBe("awaiting_approval")
    expect(s.journal.rows().find((r) => r.type === "card.refused" && r.code === "KEY_LIMIT_REACHED")).toMatchObject({ agent: "momentum" })
    // At the reset it lifts.
    s.tick(3_600_000)
    expect((await s.propose(buy("0.06"))).state).toBe("awaiting_approval")
  })

  test("a key Candle stopped holds its sells too, in Candle's words, then Candle is asked again", async () => {
    const s = await setup()
    s.holds.note("momentum", { code: "RISK_LIMIT_REACHED" }, T0)
    expect((await refusal(s.propose({ mint: MOON, side: "sell", percent: 50 }))).code).toBe("RISK_LIMIT_REACHED")
    expect((await refusal(s.propose(buy()))).message).toContain("the owner resumes it in Candle's Agent Console")
    s.tick(300_000)
    expect((await s.propose({ mint: MOON, side: "sell", percent: 50 })).state).toBe("awaiting_approval")
  })

  test("a card made before the hold is refused at approval, and nothing runs", async () => {
    const s = await setup()
    const card = await s.propose(buy())
    s.holds.note("momentum", { code: "KEY_LIMIT_REACHED", resetsAt: T0 + 60_000 }, T0)
    const r = await refusal(s.book.approve(VIEW, card.cardId, card.cardHash, "enter"))
    expect(r.code).toBe("KEY_LIMIT_REACHED")
    expect(s.executed).toHaveLength(0)
    expect(s.journal.rows().at(-1)).toMatchObject({ type: "approval.refused", code: "KEY_LIMIT_REACHED" })
  })
})

describe("Candle's per-asset cap on a buy", () => {
  const capped = (caps: AgentStatus["assetCaps"]) => ({ statuses: { momentum: status({ assetCaps: caps }), swing: status() } })

  test("a buy over the key's cap for the asset it spends is refused in Candle's words; at the cap it's a card", async () => {
    const s = await setup(capped([{ asset: "sol", maxPerTxRaw: "40000000" }]))
    const over = await refusal(s.propose(buy("0.05")))
    expect(over).toMatchObject({ code: "SPEND_LIMIT_EXCEEDED", message: "Over momentum's Candle cap of 0.04 SOL a buy: this buy spends 0.05 SOL. Nothing was sent; a smaller amount can go." })
    expect((await s.propose(buy("0.04"))).state).toBe("awaiting_approval")
  })

  test("a sell, a swap, another asset's cap and another key aren't touched", async () => {
    const s = await setup(capped([{ asset: "sol", maxPerTxRaw: "1" }, { asset: "usdc", maxPerTxRaw: "1" }]))
    expect((await s.propose({ mint: MOON, side: "sell", percent: 100 })).state).toBe("awaiting_approval")
    expect((await s.propose({ from: "SOL", to: "USDC", amount: "0.05" }, { tool: "candle_swap" })).state).toBe("awaiting_approval")
    expect((await s.propose(buy(), { client: { clientId: "h2", role: "harness", agent: "swing" } })).state).toBe("awaiting_approval")
    const cndlOnly = await setup(capped([{ asset: "cndl", maxPerTxRaw: "1" }]))
    expect((await cndlOnly.propose(buy())).state).toBe("awaiting_approval")
  })
})

describe("a wallet's spend without a card", () => {
  test("every approval journals its wallet; only the core's inside-limits approval counts towards the wallet", async () => {
    const s = await setup()
    s.setWallet(WALLET, { setting: "inside", perTradeUsd: 10, perDayUsd: 50 })
    const pressed = await s.propose(buy("0.01"))
    await s.book.approve(VIEW, pressed.cardId, pressed.cardHash, "enter")
    expect(s.journal.rows().findLast((r) => r.type === "card.approved")).toMatchObject({ wallet: WALLET, how: "enter" })
    expect(s.walletSpend.spent(WALLET, s.now())).toBe(0)
    const alone = await s.propose(buy("0.02"))
    await s.book.approve(VIEW, alone.cardId, alone.cardHash, "inside-limits")
    expect(s.journal.rows().findLast((r) => r.type === "card.approved")).toMatchObject({ wallet: WALLET, how: "inside-limits" })
    expect(s.walletSpend.spent(WALLET, s.now())).toBeCloseTo(alone.value.usd!, 6)
    // The agent's own day counts both.
    expect(s.spend.spent("momentum", s.now())).toBeCloseTo(pressed.value.usd! + alone.value.usd!, 6)
  })
})

// A trade inside its wallet's figures runs with no card, approved by the core as `inside-limits` in the same
// call. Pins one test per condition, a shared wallet's day figure across racing agents, and the pause
// stopping buys with no card while sells still go.
describe("trades with no card", () => {
  const INSIDE: WalletSetting = { setting: "inside", perTradeUsd: 1, perDayUsd: 2 }
  // 0.006 SOL at $150, with Candle's 0.5% fee: $0.9045, under the $1.00 figure. 0.007 SOL is $1.06.
  const small = () => buy("0.006")
  const sell = (percent = 50) => ({ mint: MOON, side: "sell", percent })
  const SWING: FaceClient = { clientId: "h2", role: "harness", agent: "swing" }
  const run = async (s: Awaited<ReturnType<typeof setup>>, args: Record<string, unknown>, client: FaceClient = HARNESS, tool = "candle_trade") => {
    const card = await s.propose(args, { client, tool })
    return s.book.runWithoutCard(card, client)
  }

  test("inside both figures: approved by the core in the same call, journalled with what it was checked against", async () => {
    const s = await setup()
    s.setWallet(WALLET, INSIDE)
    const out = await run(s, small())
    expect(out.ran?.kind).toBe("submitted")
    expect(out.card).toMatchObject({ state: "approved", approvedHow: "inside-limits" })
    expect(out.card.withoutCard).toBe("without a card, inside the embedded wallet's limits ($0.90 of $1.00 a trade, $0.90 of $2.00 today)")
    expect(s.executed.map((c) => c.cardId)).toEqual([out.card.cardId])
    const approved = s.journal.rows().findLast((r) => r.type === "card.approved")!
    expect(approved).toMatchObject({ how: "inside-limits", wallet: WALLET, viewClientId: "h1", inside: { perTradeUsd: 1, perDayUsd: 2, usedUsd: 0 } })
    expect(s.walletSpend.spent(WALLET, s.now())).toBeCloseTo(out.card.value.usd!, 6)
    expect(s.spend.spent("momentum", s.now())).toBeCloseTo(out.card.value.usd!, 6)
  })

  test("a wallet that asks every time: a card, and nothing said about figures", async () => {
    const s = await setup()
    const out = await run(s, small())
    expect(out.ran).toBeUndefined()
    expect(out.card.state).toBe("awaiting_approval")
    expect(out.card.cardBecause).toBeUndefined()
    expect(s.executed).toHaveLength(0)
    // Another wallet trading inside limits doesn't reach this one.
    s.setWallet("OtherWallet1111111111111111111111111111111", INSIDE)
    expect((await run(s, buy("0.005"))).ran).toBeUndefined()
  })

  test("over the wallet's figure for a trade: a card, saying which figure", async () => {
    const s = await setup()
    s.setWallet(WALLET, INSIDE)
    const out = await run(s, buy("0.007"))
    expect(out.ran).toBeUndefined()
    expect(out.card.cardBecause).toBe("over the embedded wallet's $1.00 a trade without a card: this one is $1.06 with Candle's fee")
    expect(out.card.display.cardBecause).toBe(out.card.cardBecause)
    // Journalled with its life, for the Journal's words.
    expect(s.journal.rows().findLast((r) => r.type === "card.because")).toMatchObject({ cardId: out.card.cardId, opId: out.card.opId, agent: out.card.agent, words: out.card.cardBecause })
    expect(s.executed).toHaveLength(0)
    // At the figure exactly, it runs.
    s.setWallet(WALLET, { setting: "inside", perTradeUsd: 1.06, perDayUsd: 2 })
    s.prices.set(SOL, 1 / 0.007 / 1.005)
    expect((await run(s, buy("0.007", MOON))).ran?.kind).toBe("submitted")
  })

  test("over the wallet's day figure without a card: a card, with today's use; cards and sells don't use it up", async () => {
    const s = await setup()
    s.setWallet(WALLET, INSIDE)
    expect((await run(s, small())).ran?.kind).toBe("submitted")
    // A card the person pressed counts towards the agent's day, never the wallet's.
    const pressed = await s.propose(buy("0.0061"))
    await s.book.approve(VIEW, pressed.cardId, pressed.cardHash, "enter")
    expect((await run(s, sell())).ran?.kind).toBe("submitted")
    expect((await run(s, buy("0.0062"))).ran?.kind).toBe("submitted")
    const third = await run(s, buy("0.0063"))
    expect(third.ran).toBeUndefined()
    expect(third.card.cardBecause).toMatch(/^over the embedded wallet's \$2\.00 a day without a card: \$1\.84 used today, and this \$0\.95 with Candle's fee would make \$2\.79$/)
    // Tomorrow it's fresh.
    s.tick(24 * 3_600_000)
    expect((await run(s, buy("0.0064"))).ran?.kind).toBe("submitted")
  })

  test("a failed trade gives its spend back to the wallet's day", async () => {
    const s = await setup()
    s.setWallet(WALLET, INSIDE)
    const first = await run(s, small())
    s.walletSpend.settle(first.card.opId, "failed")
    s.spend.settle(first.card.opId, "failed")
    expect((await run(s, buy("0.0061"))).ran?.kind).toBe("submitted")
  })

  test("a buy or swap with no price is a card; a sell with no price runs", async () => {
    const s = await setup({ prices: {} })
    s.setWallet(WALLET, INSIDE)
    const unpriced = await run(s, small())
    expect(unpriced.ran).toBeUndefined()
    expect(unpriced.card.cardBecause).toBe("no price, so the embedded wallet's figures can't be checked")
    const swapped = await run(s, { from: "SOL", to: "USDC", amount: "0.001" }, HARNESS, "candle_swap")
    expect(swapped.ran).toBeUndefined()
    const sold = await run(s, sell(100))
    expect(sold.ran?.kind).toBe("submitted")
    expect(sold.card.withoutCard).toBe("without a card: the embedded wallet trades inside limits, and sells aren't limited")
  })

  test("a slippage bound looser than the route's default is a card, sells and buys alike; the default or a tighter one runs", async () => {
    const s = await setup()
    s.setWallet(WALLET, INSIDE)
    const loose = await run(s, { ...sell(100), maxSlippageBps: 10_000 })
    expect(loose.ran).toBeUndefined()
    expect(loose.card.state).toBe("awaiting_approval")
    expect(loose.card.cardBecause).toBe("slippage 100%, the default is 1%, looser than that, so this one waits for you")
    const looseBuy = await run(s, { ...small(), maxSlippageBps: 500 })
    expect(looseBuy.ran).toBeUndefined()
    expect(looseBuy.card.cardBecause).toContain("slippage 5%, the default is 1%")
    const looseSwap = await run(s, { from: "SOL", to: "USDC", amount: "0.006", maxSlippageBps: 300 }, HARNESS, "candle_swap")
    expect(looseSwap.ran).toBeUndefined()
    expect(s.executed).toEqual([])
    expect((await run(s, { ...sell(25), maxSlippageBps: 100 })).ran?.kind).toBe("submitted")
    expect((await run(s, { ...sell(10), maxSlippageBps: 50 })).ran?.kind).toBe("submitted")
  })

  test("a swap inside the figures runs", async () => {
    const s = await setup()
    s.setWallet(WALLET, INSIDE)
    const out = await run(s, { from: "SOL", to: "USDC", amount: "0.006" }, HARNESS, "candle_swap")
    expect(out.ran?.kind).toBe("submitted")
    expect(out.card.approvedHow).toBe("inside-limits")
  })

  test("over the agent's own Candle Harness limit: refused at proposal, as with a card", async () => {
    const s = await setup()
    s.setWallet(WALLET, { setting: "inside", perTradeUsd: 100, perDayUsd: 500 })
    const r = await refusal(s.propose(buy("0.1")))
    expect(r.code).toBe("OVER_TRADE_LIMIT")
    expect(s.executed).toHaveLength(0)
  })

  test("paused: a buy or swap with no card is refused, a sell still runs", async () => {
    const s = await setup()
    s.setWallet(WALLET, INSIDE)
    s.setPaused(true)
    expect((await refusal(run(s, small()))).code).toBe("PAUSED")
    expect((await refusal(run(s, { from: "SOL", to: "USDC", amount: "0.001" }, HARNESS, "candle_swap"))).code).toBe("PAUSED")
    expect((await run(s, sell())).ran?.kind).toBe("submitted")
    expect(s.executed).toHaveLength(1)
  })

  test("a key Candle refused for its cap: its buys are refused, its sells run", async () => {
    const s = await setup()
    s.setWallet(WALLET, INSIDE)
    s.holds.note("momentum", { code: "KEY_LIMIT_REACHED", resetsAt: T0 + 3_600_000 }, T0)
    expect((await refusal(run(s, small()))).code).toBe("KEY_LIMIT_REACHED")
    expect((await run(s, sell())).ran?.kind).toBe("submitted")
  })

  test("two agents racing on one wallet at its day figure: one runs, one is a card", async () => {
    const s = await setup()
    s.setWallet(WALLET, { setting: "inside", perTradeUsd: 1, perDayUsd: 1.5 })
    const [a, b] = await Promise.all([run(s, small()), run(s, small(), SWING)])
    expect([a.ran?.kind, b.ran?.kind].filter(Boolean)).toEqual(["submitted"])
    const card = a.ran ? b.card : a.card
    expect(card.state).toBe("awaiting_approval")
    expect(card.cardBecause).toContain("$1.50 a day without a card")
    expect(s.executed).toHaveLength(1)
    expect(s.walletSpend.spent(WALLET, s.now())).toBeLessThanOrEqual(1.5)
  })

  test("racing proposals made first, then run together: the figure still holds", async () => {
    const s = await setup()
    s.setWallet(WALLET, { setting: "inside", perTradeUsd: 1, perDayUsd: 1.5 })
    const cards = await Promise.all([s.propose(small()), s.propose(buy("0.0061"), { client: SWING })])
    const outs = await Promise.all([s.book.runWithoutCard(cards[0], HARNESS), s.book.runWithoutCard(cards[1], SWING)])
    expect(outs.filter((o) => o.ran).length).toBe(1)
  })

  test("the same trade again while the first is still in flight without a card waits for the person", async () => {
    const s = await setup()
    s.setWallet(WALLET, INSIDE)
    const gate = s.holdExecution()
    const first = run(s, buy("0.003"))
    await new Promise((r) => setTimeout(r, 5))
    const again = await run(s, buy("0.003"))
    expect(again.ran).toBeUndefined()
    expect(again.card.cardBecause).toBe("the same trade is still in flight, so this one waits for you")
    gate.open()
    expect((await first).ran?.kind).toBe("submitted")
  })

  test("a sell the person approved on a card, still unanswered, makes the agent's same sell a card, not a second sell", async () => {
    const s = await setup()
    const first = await s.propose({ mint: MOON, side: "sell", percent: 50 })
    await s.book.approve(VIEW, first.cardId, first.cardHash)
    s.book.noteOperation(first.opId, { state: "unknown" })
    s.setWallet(WALLET, INSIDE)
    const again = await run(s, { mint: MOON, side: "sell", percent: 50 })
    expect(again.ran).toBeUndefined()
    expect(again.card.cardBecause).toBe("the same trade is still in flight, so this one waits for you")
    expect(s.executed.map((c) => c.cardId)).toEqual([first.cardId])
    // Once it has its answer, the same sell runs without a card again.
    s.book.noteOperation(first.opId, { state: "succeeded" })
    expect((await run(s, { mint: MOON, side: "sell", percent: 50 })).ran?.kind).toBe("submitted")
  })

  test("after a restart, a sell still being read back makes the agent's same sell a card", async () => {
    const lost = { opId: "op-before", agent: "momentum", tool: "candle_trade", params: { mint: MOON, side: "sell", percent: 50, clientTradeId: "op-before" }, state: "unknown" }
    const s = await setup({ operations: () => [lost] })
    s.setWallet(WALLET, INSIDE)
    const again = await run(s, { mint: MOON, side: "sell", percent: 50 })
    expect(again.ran).toBeUndefined()
    expect(again.card.cardBecause).toBe("the same trade is still in flight, so this one waits for you")
    // Another agent's, or another request, doesn't hold it.
    const other = await setup({ operations: () => [{ ...lost, agent: "swing" }, { ...lost, params: { ...lost.params, percent: 25 } }] })
    other.setWallet(WALLET, INSIDE)
    expect((await run(other, { mint: MOON, side: "sell", percent: 50 })).ran?.kind).toBe("submitted")
  })

  test("approve as inside-limits re-checks the rule: on a wallet that asks it approves nothing and journals nothing", async () => {
    const s = await setup()
    const card = await s.propose(small())
    const rows = s.journal.rows().length
    const r = await refusal(s.book.approve(VIEW, card.cardId, card.cardHash, "inside-limits"))
    expect(r.code).toBe("NOT_INSIDE_LIMITS")
    expect(s.journal.rows().length).toBe(rows)
    expect(s.book.get(card.cardId)!.state).toBe("awaiting_approval")
    expect(s.spend.spent("momentum", s.now())).toBe(0)
  })

  test("a TEE wallet's trade runs without a card through the CLI route, on its own figures", async () => {
    const TEE = "TeeFake111111111111111111111111111111111111"
    const s = await setup({ wallets: { payer: (_agent, word) => (word === "tee-one" ? { ok: true, kind: "tee", address: TEE, id: "tee1", label: "tee-one", chain: "solana" } : { ok: true, kind: "embedded", address: WALLET, chain: "solana" }) } })
    s.setWallet(TEE, INSIDE)
    const out = await run(s, { ...small(), wallet: "tee-one" })
    expect(out.card.route).toBe("cli")
    expect(out.ran?.kind).toBe("submitted")
    expect(out.card.withoutCard).toContain("inside tee-one's limits")
    expect(s.walletSpend.spent(TEE, s.now())).toBeCloseTo(out.card.value.usd!, 6)
    // The embedded wallet asks, so the same trade from it is a card.
    expect((await run(s, buy("0.0061"))).ran).toBeUndefined()
  })

  test("paper mode never reaches the rule: a card made in paper doesn't run alone", async () => {
    const s = await setup()
    s.setWallet(WALLET, INSIDE)
    s.setMode("paper")
    const card = await s.propose(small())
    const out = await s.book.runWithoutCard(card, HARNESS)
    expect(out.ran).toBeUndefined()
  })
})

describe("slippage the agent sets", () => {
  const TEE = "TeeFake111111111111111111111111111111111111"
  const teeWallets: CardBookDeps["wallets"] = { payer: (_agent, word) => (word === "tee-one" ? { ok: true, kind: "tee", address: TEE, id: "tee1", label: "tee-one", chain: "solana" } : { ok: true, kind: "embedded", address: WALLET, chain: "solana" }) }

  test("a bound looser than Candle's default is on the card, in its own words", async () => {
    const s = await setup()
    const card = await s.propose({ mint: MOON, side: "sell", percent: 100, maxSlippageBps: 5000 })
    expect(card.display.slippage).toBe("slippage 50%, the default is 1%")
    expect(card.display.slippageLooser).toBe(true)
  })

  test("the default, or none set, says nothing; a tighter one says so without amber", async () => {
    const s = await setup()
    expect((await s.propose({ ...buy(), maxSlippageBps: 100 })).display.slippage).toBeUndefined()
    expect((await s.propose(buy("0.04"))).display.slippage).toBeUndefined()
    const tight = await s.propose({ ...buy("0.03"), maxSlippageBps: 25 })
    expect(tight.display.slippage).toBe("slippage 0.25%, the default is 1%")
    expect(tight.display.slippageLooser).toBeUndefined()
  })

  test("a TEE wallet's bound is against the CLI's default, up to 100%", async () => {
    const s = await setup({ wallets: teeWallets })
    const card = await s.propose({ mint: MOON, side: "sell", percent: 100, maxSlippageBps: 10_000, wallet: "tee-one" })
    expect(card.route).toBe("cli")
    expect(card.display.slippage).toBe("slippage 100%, the default is 0.5%")
    expect(card.display.slippageLooser).toBe(true)
  })

  test("a malformed bound fails closed: a card, never a run with no card", async () => {
    for (const maxSlippageBps of [150.5, "5000", -1, 20_000, null]) {
      const s = await setup()
      const card = await s.propose({ mint: MOON, side: "sell", percent: 100, maxSlippageBps })
      expect(`${JSON.stringify(maxSlippageBps)}: ${card.display.slippageLooser}`).toBe(`${JSON.stringify(maxSlippageBps)}: true`)
      expect(card.display.slippage).toContain("isn't a whole number of basis points")
    }
  })

  test("a swap's bound is shown too", async () => {
    const s = await setup()
    const card = await s.propose({ from: "SOL", to: "USDC", amount: "0.01", maxSlippageBps: 300 }, { tool: "candle_swap" })
    expect(card.display.slippage).toBe("slippage 3%, the default is 1%")
  })
})

describe("an unpriced buy or swap", () => {
  test("its card says in amber that the Candle Harness limit can't check it", async () => {
    const s = await setup({ prices: { [MOON]: 0.63 } })
    const card = await s.propose(buy("5"))
    expect(card.value.unvalued).toBe(true)
    expect(card.display.nearLimit).toContain("no price, so it can't be checked")
  })

  test("is valued once it fills, so the day counts it: an agent can't spend past its day by trading unpriced", async () => {
    const s = await setup({ prices: { [MOON]: 0.63 } })
    const card = await s.propose(buy("0.2"))
    await s.book.approve(VIEW, card.cardId, card.cardHash)
    expect(s.spend.spent("momentum", s.now())).toBe(0)
    // SOL's price can be read again by the time it fills.
    s.prices.set(SOL, 150)
    s.book.noteOperation(card.opId, { state: "succeeded" })
    await Bun.sleep(5)
    // 0.2 SOL at $150, with Candle's 0.5% fee.
    expect(s.spend.spent("momentum", s.now())).toBeCloseTo(30.15, 6)
    const valued = s.journal.rows().filter((r) => r.type === "card.valued")
    expect(valued).toHaveLength(1)
    expect(valued[0]!.usd).toBeCloseTo(30.15, 6)
    // Counted once, however often its state is noted.
    s.book.noteOperation(card.opId, { state: "succeeded" })
    await Bun.sleep(5)
    expect(s.spend.spent("momentum", s.now())).toBeCloseTo(30.15, 6)
    // And after a restart.
    const rebuilt = new DaySpend()
    rebuilt.rebuild(s.journal.rows())
    expect(rebuilt.spent("momentum", s.now())).toBeCloseTo(30.15, 6)
    // A wallet's day without a card never counts it: an unpriced trade is always a card.
    const wallet = new DaySpend(byWalletWithoutCard)
    wallet.rebuild(s.journal.rows())
    expect(wallet.spent(WALLET, s.now())).toBe(0)
  })

  test("one that failed, or still has no price, isn't counted", async () => {
    const s = await setup({ prices: { [MOON]: 0.63 } })
    const card = await s.propose(buy("0.2"))
    await s.book.approve(VIEW, card.cardId, card.cardHash)
    s.book.noteOperation(card.opId, { state: "failed" })
    s.prices.set(SOL, 150)
    await Bun.sleep(5)
    expect(s.spend.spent("momentum", s.now())).toBe(0)
    s.prices.delete(SOL)
    const other = await s.propose(buy("0.3"), { client: { ...HARNESS, clientId: "h2" } })
    await s.book.approve(VIEW, other.cardId, other.cardHash)
    s.book.noteOperation(other.opId, { state: "succeeded" })
    await Bun.sleep(5)
    expect(s.spend.spent("momentum", s.now())).toBe(0)
    expect(s.journal.rows().some((r) => r.type === "card.valued")).toBe(false)
  })
})

describe("a turn's second run, made to correct its reply", () => {
  test("the same request again is the first run's card, filled or rejected, never a second trade; a different one is its own", async () => {
    let correcting = false
    const s = await setup({ turnOf: (tokenId) => ({ turnId: tokenId === "tok-1" ? "turn-1" : "turn-2", msSinceStart: 0, ...(correcting && tokenId === "tok-1" ? { correcting: true as const } : {}) }) })
    s.setWallet(WALLET, { setting: "inside", perTradeUsd: 100, perDayUsd: 100 })
    // Each run's harness connects afresh, under the turn's one token.
    const first: FaceClient = { ...HARNESS, clientId: "h-run-1", tokenId: "tok-1" }
    const second: FaceClient = { ...HARNESS, clientId: "h-run-2", tokenId: "tok-1" }
    const bought = await s.propose(buy("0.01"), { client: first })
    await s.book.runWithoutCard(bought, first)
    s.book.noteOperation(bought.opId, { state: "succeeded" })
    const turned = await s.propose(buy("0.02"), { client: first })
    await s.book.reject(VIEW, turned.cardId)
    expect(s.executed).toHaveLength(1)

    correcting = true
    const again = await s.propose(buy("0.01"), { client: second })
    expect(again.cardId).toBe(bought.cardId)
    expect((await s.book.runWithoutCard(again, second)).ran).toBeUndefined()
    expect((await s.propose(buy("0.02"), { client: second })).cardId).toBe(turned.cardId)
    expect(s.executed).toHaveLength(1)
    expect(s.journal.rows().filter((r) => r.type === "card.created")).toHaveLength(2)
    // What the first run never asked for is a card of its own.
    expect((await s.propose(buy("0.03"), { client: second })).cardId).not.toBe(bought.cardId)
    // In a later turn the same request is a new trade, as ever.
    const later: FaceClient = { ...HARNESS, clientId: "h-next", tokenId: "tok-2" }
    expect((await s.propose(buy("0.01"), { client: later })).cardId).not.toBe(bought.cardId)
    expect(s.journal.rows().filter((r) => r.type === "card.created")).toHaveLength(4)
  })
})

describe("a turn stopped while its card is being priced", () => {
  test("no card is made and no card row is written, for a trade or any other card; other turns and clients still get theirs", async () => {
    // The stop lands once the first read for the card is out.
    let stopped = false
    const s = await setup({ turnEnded: (tokenId) => tokenId === "tok-stopped" && stopped })
    const reads = s.network.push.bind(s.network)
    s.network.push = (...items: string[]) => ((stopped = true), reads(...items))
    const inTurn: FaceClient = { ...HARNESS, tokenId: "tok-stopped" }
    s.setWallet(WALLET, { setting: "inside", perTradeUsd: 100, perDayUsd: 100 })
    const r = await refusal(s.propose(buy(), { client: inTurn }))
    expect(r.code).toBe("TURN_ENDED")
    expect(s.network.length).toBeGreaterThan(0)
    // A card that needs no read is refused the same way once the turn is over.
    expect((await refusal(s.propose({ label: "x" }, { tool: "made_up_tool", client: inTurn }))).code).toBe("TURN_ENDED")
    expect(s.book.list()).toEqual([])
    const types = s.journal.rows().map((row) => row.type)
    expect(types.filter((t) => t.startsWith("card."))).toEqual(["card.refused", "card.refused"])
    expect(s.journal.rows()[0]).toMatchObject({ code: "TURN_ENDED", tool: "candle_trade" })
    // Another turn's token, a harness with none, and the person's own view are untouched.
    expect((await s.propose(buy("0.01"), { client: { ...HARNESS, tokenId: "tok-running" } })).state).toBe("awaiting_approval")
    expect((await s.propose(buy("0.02"))).state).toBe("awaiting_approval")
    expect((await s.propose(buy("0.03"), { client: { clientId: "v9", role: "view", agent: "momentum", tokenId: "tok-stopped" } as FaceClient })).state).toBe("awaiting_approval")
  })
})

describe("what a trade's token may be", () => {
  const CNDL = BASE_ASSETS.CNDL.priceKey!

  test("what trades spend is refused as a trade's token, buy or sell, before anything is read; CNDL still trades", async () => {
    // Candle answers the SOL and USDC mints as routable markets, so nothing else would stop them.
    const s = await setup({ resolve: { [SOL]: market(SOL, { candleLaunched: false }), [USDC]: market(USDC, { candleLaunched: false }), [CNDL]: market(CNDL, { candleLaunched: false, metadata: { symbol: "CNDL" } }) }, holdings: { [USDC]: 5_000_000_000n, [CNDL]: 1_000_000n }, prices: { [SOL]: 150, [USDC]: 1, [CNDL]: 0.2 } })
    s.setWallet(WALLET, { setting: "inside", perTradeUsd: 1, perDayUsd: 2 })
    s.setPaused(true)
    for (const [mint, name] of [[SOL, "SOL"], [USDC, "USDC"], ["hood:native", "ETH"]] as const) {
      // The kill switch is on, which a sell passes: the refusal is the token's, not the pause's.
      const r = await refusal(s.propose({ mint, side: "sell", percent: 100, quoteAsset: "cndl" }))
      expect(r.code).toBe("BASE_ASSET")
      expect(r.message).toStartWith(`${name} is what trades spend`)
    }
    s.setPaused(false)
    for (const mint of [SOL, USDC]) expect((await refusal(s.propose({ mint, side: "buy", amount: "1" }))).code).toBe("BASE_ASSET")
    expect(s.network).toEqual([])
    expect(s.book.list()).toEqual([])
    // CNDL is a quote asset too, and people trade it like any token.
    const card = await s.propose({ mint: CNDL, side: "sell", percent: 50 })
    expect(card.display.headline).toBe("SELL 50% of CNDL")
  })

  test("on Hood, USDG and WETH by address are refused as a trade's token in any case, before anything is read", async () => {
    const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"
    const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"
    const s = await setup()
    for (const [mint, name] of [[USDG, "USDG"], [USDG.toLowerCase(), "USDG"], [WETH, "WETH"], [WETH.toLowerCase(), "WETH"]] as const) {
      for (const side of ["buy", "sell"] as const) {
        const r = await refusal(s.propose(side === "buy" ? { mint, side, amount: "0.01" } : { mint, side, percent: 100 }))
        expect(r.code).toBe("BASE_ASSET")
        expect(r.message).toStartWith(`${name} is`)
      }
    }
    expect(s.network).toEqual([])
    expect(s.book.list()).toEqual([])
  })

  test("the same refusal on a TEE wallet, where a sell would be the very swap the limits would have checked", async () => {
    const TEE = "TeeWalletFake111111111111111111111111111111"
    const s = await setup({ resolve: { [USDC]: market(USDC, { candleLaunched: false }) }, wallets: { payer: () => ({ ok: true, kind: "tee", address: TEE, label: "tee-one" }) as never } })
    expect((await refusal(s.propose({ mint: USDC, side: "sell", amount: "5000", quoteAsset: "cndl", wallet: "tee-one" }))).code).toBe("BASE_ASSET")
  })
})

describe("arguments a card tool doesn't list", () => {
  test("a trade or a swap with an argument the list doesn't name is refused by name, and no card is made", async () => {
    const s = await setup()
    const trade = await refusal(s.propose({ ...buy(), payer: "linked" }))
    expect(trade.code).toBe("UNKNOWN_ARGUMENT")
    expect(trade.message).toBe("candle_trade doesn't take `payer` here. Nothing was sent.")
    const swap = await refusal(s.propose({ from: "SOL", to: "USDC", amount: "0.01", recipient: "x" }, { tool: "candle_swap" }))
    expect(swap.message).toContain("`recipient`")
    expect(s.book.list()).toEqual([])
    // The Candle Harness's own arguments still pass.
    expect((await s.propose({ mint: MOON, side: "buy", amountUsd: "5", wallet: "embedded" })).state).toBe("awaiting_approval")
  })
})

describe("an expired card that isn't a trade or one of Candle's tools", () => {
  const flatten = (s: Awaited<ReturnType<typeof setup>>) =>
    s.book.propose({ client: HARNESS, agent: "momentum", tool: "harness_bots", args: { action: "flatten", name: "conf" }, params: { action: "flatten", name: "conf", proposer: "momentum" }, kind: "bot", idKey: "coreOpId", title: 'FLATTEN BOT "conf"', warning: "sells every open position" })

  test("is asked for again: a re-quote refuses, and no card is made from what was asked alone", async () => {
    const s = await setup()
    const card = await flatten(s)
    expect(card.display.askAgain).toBe(true)
    s.tick(10 * 60_000)
    await s.book.expireDue()
    const r = await refusal(s.book.requote(VIEW, card.cardId))
    expect(r.code).toBe("ASK_AGAIN")
    expect(r.message).toContain("ask for it again")
    expect(s.book.list().map((c) => c.display.title)).toEqual(['FLATTEN BOT "conf"'])
  })

  test("pressed after it expired, it expires and nothing approvable takes its place", async () => {
    const s = await setup()
    const card = await flatten(s)
    s.tick(10 * 60_000)
    expect((await refusal(s.book.approve(VIEW, card.cardId, card.cardHash))).code).toBe("ASK_AGAIN")
    expect(s.book.list().filter((c) => c.state === "awaiting_approval")).toEqual([])
    expect(s.book.list().some((c) => c.display.title.includes("not supported yet"))).toBe(false)
    expect(s.executed).toEqual([])
  })

  test("a trade and Candle's own tools are still re-quoted, and carry no such mark", async () => {
    const s = await setup()
    expect((await s.propose(buy())).display.askAgain).toBeUndefined()
    const wallets = await s.propose({ keyPrefix: "momeAb3d", walletIds: ["w1"] }, { tool: "candle_set_profile_wallets" })
    expect(wallets.display.askAgain).toBeUndefined()
    s.tick(10 * 60_000)
    await s.book.expireDue()
    expect((await s.book.requote(VIEW, wallets.cardId)).display.title).toBe(wallets.display.title)
  })
})

describe("what a card says in words", () => {
  test("narrowing a key's wallets names the key and how many wallets it keeps", async () => {
    const s = await setup()
    expect((await s.propose({ keyPrefix: "momeAb3d", walletIds: ["w1", "w2"] }, { tool: "candle_set_profile_wallets" })).display.title).toBe("LESS ACCESS · key momeAb3d keeps 2 wallets")
    expect((await s.propose({ keyPrefix: "momeAb3d", walletIds: [] }, { tool: "candle_set_profile_wallets" })).display.title).toBe("LESS ACCESS · key momeAb3d keeps no wallets")
    expect((await refusal(s.propose({ keyPrefix: "momeAb3d" }, { tool: "candle_set_profile_wallets" }))).code).toBe("INVALID_WALLETS")
  })

  test("a launch names every link's host, the image's, and the description; terms left at Candle's defaults add no line", () => {
    const given = { name: "Fake Moon", symbol: "FMOON", imageUrl: "https://img.example.com/a.png", bannerUrl: "https://cdn.example.org/b.png", description: "To the fake moon.\u001b[31m", socials: { website: "https://fakemoon.example/home", twitter: "https://x.com/fakemoon" } }
    expect(launchPublishes(given)).toBe("links: website fakemoon.example, twitter x.com · image from img.example.com · banner from cdn.example.org · description: To the fake moon.[31m")
    expect(launchTerms(given)).toBeUndefined()
    expect(launchPublishes({ name: "x", symbol: "y" })).toBeUndefined()
  })

  test("a creator fee, a staker share, a mode or launch rules the agent set are said, for the card's amber line", () => {
    expect(launchTerms({ creatorFeeBps: 500, stakerAllocationBps: 0, mode: "fair", visibility: "public", launchRules: { maxWalletPct: 2 } })).toBe(`set by the agent, not Candle's defaults: creator fee 5% · staker share 0% · mode fair · launch rules {"maxWalletPct":2}`)
  })

  test("a token whose name is held or was carded here under another mint says so, with both short addresses; any other card says nothing", async () => {
    const COPY = "MoonCopy11111111111111111111111111111111111"
    const s = await setup({ otherMints: (symbol, mint) => (symbol === "MOON" && mint === MOON ? [COPY] : []) })
    const card = await s.propose(buy())
    expect(card.display.otherMint).toBe("another MOON is in a wallet or on an earlier card here (Moon…1111): this one is Moon…1111")
    expect(card.display.mint).toBe(MOON)
    expect((await s.propose(buy("0.01", PEPE))).display.otherMint).toBeUndefined()
  })

  test("a live bot's trade while the Candle Harness is on paper says real funds; with both live, nothing", async () => {
    const s = await setup()
    const bot: FaceClient = { clientId: "core", role: "core", agent: "momentum", bot: { name: "conf", act: "entry", mode: "live" } as never }
    expect((await s.propose(buy(), { client: bot })).display.modeDiffers).toBeUndefined()
    s.setMode("paper")
    const card = await s.propose(buy("0.02"), { client: bot })
    expect(card.mode).toBe("live")
    expect(card.display.modeDiffers).toBe('real funds: the bot "conf" is live, though the Candle Harness is on paper')
  })
})

describe("how many cards the book keeps", () => {
  test("closed cards past the newest are dropped, each told to whoever kept something by its id; an open card always stays", async () => {
    const s = await setup()
    const dropped: string[] = []
    ;(s.book as unknown as { deps: CardBookDeps }).deps.onDropped = (card) => dropped.push(card.cardId)
    const open = await s.propose(buy("0.001"))
    const made: string[] = []
    for (let i = 0; i < CLOSED_CARDS_KEPT + 20; i++) {
      const card = await s.propose(buy(`0.01${String(i).padStart(4, "0")}`))
      made.push(card.cardId)
      await s.book.reject(VIEW, card.cardId)
    }
    const listed = s.book.list()
    expect(listed.length).toBeLessThanOrEqual(CLOSED_CARDS_KEPT + 1)
    expect(listed[0]!.cardId).toBe(open.cardId)
    expect(s.book.get(made[0]!)).toBeUndefined()
    expect(s.book.held(listed[0]!.opId)?.cardId).toBe(open.cardId)
    expect(dropped.slice(0, 2)).toEqual(made.slice(0, 2))
    expect((await refusal(s.book.reject(VIEW, made[0]!))).code).toBe("CARD_NOT_FOUND")
  })

  test("a list sent to a view fits one message: every open card, then the newest closed ones", async () => {
    const s = await setup()
    const first = await s.propose(buy("0.001"))
    for (let i = 0; i < 40; i++) await s.book.reject(VIEW, (await s.propose(buy(`0.01${String(i).padStart(4, "0")}`))).cardId)
    const all = s.book.list()
    const one = Buffer.byteLength(JSON.stringify(all[1]), "utf8")
    const within = s.book.listWithin(one * 10)
    expect(within[0]!.cardId).toBe(first.cardId)
    expect(within.length).toBeGreaterThan(3)
    expect(within.length).toBeLessThan(12)
    expect(within.at(-1)!.cardId).toBe(all.at(-1)!.cardId)
    expect(Buffer.byteLength(JSON.stringify(s.book.listWithin()), "utf8")).toBeLessThan(CARDS_LIST_BYTES + 1024)
  })
})
