// A stand-in for Candle's MCP server (`candle mcp` or `candle-mcp`): made-up data, no network, no keys.
// It serves the real server's tools/list, recorded in fixtures/candle-tools.json, and
// answers the core's tools. The answers for the reads, the paper buy and a missing operation follow the
// shapes recorded from Candle's real server (fixtures/candle-recorded/, checked by recorded.test.ts); the
// rest follow the agentic source and Candle's docs (docs.candle.tv/developers/mcp-server "Error shapes",
// docs.candle.tv/developers/agent-trading "Errors"), and are made up where neither says.
//
// Tests script it through files in $CANDLE_CONFIG_DIR, the private folder the core gives each child,
// since the child's environment is allowlisted and can't carry test switches:
//   fake-candle.json         the script (FakeScript below), read on every call
//   fake-candle-seen.json    written at start: argv, environment and pid
//   fake-candle-calls.jsonl  one line per tool call
//   fake-candle-ledger.json  trades, swaps, launches and stakes by id, kept across restarts
//
// The card tools answer in the shapes of agentic's mcp/src/tools.ts and orchestrate.ts and
// the docs (docs.candle.tv/developers/headless-launch, docs.candle.tv/developers/claims, docs.candle.tv/developers/agent-trading "CNDL
// staking"); none was recorded, since nothing was launched, staked or posted on a real account.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import fixture from "./fixtures/candle-tools.json"
// The lists', P&L's and perps' recorded shapes, bundled so the compiled fake carries them.
import feedFinalStretch from "./fixtures/candle-recorded/feeds-pnl/feed-finalstretch-all-fields.json"
import feedGraduated from "./fixtures/candle-recorded/feeds-pnl/feed-graduated-all-fields.json"
import feedNew from "./fixtures/candle-recorded/feeds-pnl/feed-new-all-fields.json"
import feedUnknownField from "./fixtures/candle-recorded/feeds-pnl/feed-new-unknown-field.json"
import feedOnFire from "./fixtures/candle-recorded/feeds-pnl/feed-onfire-all-fields.json"
import feedUnknownBucket from "./fixtures/candle-recorded/feeds-pnl/feed-unknown-bucket.json"
import emptyPnl from "./fixtures/candle-recorded/feeds-pnl/pnl-self.json"
import perpsMarkets from "./fixtures/candle-recorded/feeds-pnl/perps-markets-5.json"
import { requestsOf } from "../src/core/key-budget"

export type Behaviour =
  | "ok"
  | "transport" // MCP_TRANSPORT, as the server reports a request that failed in transit
  | "hang" // never answers
  | "die" // exits mid-call
  | "die-once" // exits mid-call the first time, then answers
  | "sell-to-paper" // a live sell the server turned to paper (the live wallet was empty)
  | "validation-text" // the SDK's own refusal of bad arguments: plain text, nothing sent
  | "throw-text" // a handler that threw: plain text, nobody knows what was sent
  | "garbled" // a reply that isn't JSON
  | { refuse: string; status?: number; retryable?: boolean; stage?: string; extra?: Record<string, unknown> }

export interface FakeScript {
  version?: string
  initializeDelayMs?: number
  /** A sell's answer comes this late, as a real fill takes seconds. */
  sellDelayMs?: number
  tools?: Record<string, Behaviour>
  /** This key's embedded-wallet permission (docs.candle.tv/developers/agent-wallets); `allowed` when unset. */
  embeddedWalletPermission?: "allowed" | "denied"
  /** Mints the portfolio's price map leaves out (`priceUsd: null`). */
  unpriced?: string[]
  /** The account's plan fee (docs.candle.tv/developers/agent-trading, "Fee model"); Pro's 50 bps when unset. */
  feeBps?: number
  /** Parts of candle_execution_status that couldn't be read (docs.candle.tv/developers/mcp-server, "Doing a job end to end"). */
  unreadable?: string[]
  /** Printed to stderr before the server exits at start, as the real one does when it can't start; `$KEY` becomes the key. */
  startError?: string
  /** The account's TEE wallets, each bound to one key by its prefix; none when unset (in the recorded shapes). */
  teeWallets?: FakeTeeWallet[]
  /** candle_get_portfolio's `walletsComplete` (true when unset): false as when Candle cut the wallet list off. */
  walletsComplete?: boolean
  /** The account's plan, as candle_execution_status's `tier.tier` names it; "pro" when unset. */
  tier?: "free" | "pro" | "max"
  /** A second token called MOON, held in the embedded wallet too: a ticker the wallet holds two of (the scorecard's sell-twin case). */
  heldTwin?: boolean
  /** The token check comes back clear on all six flags, sellability measured (the scorecard's woken cases); unset, sellability is unknown. */
  forensicsClear?: boolean
  /** Real tokens Candle answers the market read and check for, beside the fake two: a run in tmux against the real Hacc. */
  markets?: { mint: string; symbol: string; priceUsd: number }[]
  /** Any other Solana mint answers too, at this price, named by its first four characters: a bot in tmux entering on the real tape. `markets` wins for a mint it names. */
  anyMint?: { priceUsd: number }
  /** Final Stretch where its source is off (refused as an unknown bucket) or behind (`stale`, `feed.ok` false), as the docs say it can be. */
  finalStretch?: "on" | "off" | "stale"
  /** candle_get_profile_pnl's answer by key prefix: the recorded shape (fixtures/candle-recorded/feeds-pnl). A prefix not here answers an empty book, as Candle does for any prefix. */
  pnl?: Record<string, unknown>
  /** candle_get_profile_trades's rows by key prefix, newest first; none when unset. */
  trades?: Record<string, unknown[]>
  /**
   * Candle's per-key request limit, enforced: a call past this many in the last minute is refused
   * RATE_LIMITED, as Candle does (docs.candle.tv/developers/agent-wallets), and logged with `limited: true`. Unset,
   * nothing is refused. The status read's `tierCaps.rateLimitPerMin` says the plan's either way.
   */
  rateLimitPerMin?: number
  /** This key has no Candle cap: no `txLimit` and no per-asset caps, as every key starts (docs.candle.tv/developers/agent-wallets). $100 a UTC day when unset. */
  uncapped?: boolean
  /**
   * Candle's circuit breaker, enforced on this key (docs.candle.tv/developers/agent-trading, "RISK_LIMIT_REACHED"): the
   * trade that would make 30 inside a rolling minute, live or paper, and a third failed sell of one token in a row, stop
   * the key; every trade after answers RISK_LIMIT_REACHED. Stricter than Candle by one, so a run that never trips here
   * never trips there. `failSells`: mints whose sells land and revert (TRADE_REVERTED, stage reverted).
   */
  breaker?: { failSells?: string[] }
}

export interface FakeTeeWallet {
  id: string
  address: string
  label?: string
  boundKeyPrefix: string
  active?: boolean
  lamports?: string
  /** "hood" for a Hood TEE wallet: under the portfolio's `hood.tee`, and "evm" in the key's list, as Candle answers; Solana when unset. */
  chain?: "solana" | "hood"
}

export const FAKE_MINTS = {
  MOON: "MoonFake11111111111111111111111111111111111",
  PEPE: "PepeFake11111111111111111111111111111111111",
} as const
export const FAKE_WALLET = "WalletFake111111111111111111111111111111111"
export const FAKE_EVM_WALLET = "0x00000000000000000000000000000000000Fa4e1"
// The base assets' real mints (docs.candle.tv/developers/networks-and-contracts), so price lookups match the app's.
const SOL_MINT = "So11111111111111111111111111111111111111112"
const CNDL_MINT = "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL"
/** The second MOON `heldTwin` adds: 5,000 of it, at $0.0021. */
export const MOON_TWIN = "MoonTwin11111111111111111111111111111111111"
/** What every fake launch mints. */
export const LAUNCHED_MINT = "LaunchFake111111111111111111111111111111111"
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
export const FAKE_PRICES_USD: Record<string, number> = { [SOL_MINT]: 150, [USDC_MINT]: 1, [FAKE_MINTS.MOON]: 0.63, [FAKE_MINTS.PEPE]: 0.165 }
/** What the fake's embedded wallet holds: 12,345.678901 MOON (6 decimals) and 2 SOL. */
export const FAKE_HOLDINGS = { lamports: "2000000000", moonRaw: "12345678901" }

const dir = process.env.CANDLE_CONFIG_DIR
if (!dir) throw new Error("fake-candle-mcp needs CANDLE_CONFIG_DIR")
const scriptPath = join(dir, "fake-candle.json")
const ledgerPath = join(dir, "fake-candle-ledger.json")

function script(): FakeScript {
  return existsSync(scriptPath) ? (JSON.parse(readFileSync(scriptPath, "utf8")) as FakeScript) : {}
}

writeFileSync(join(dir, "fake-candle-seen.json"), JSON.stringify({ argv: process.argv.slice(2), env: process.env, pid: process.pid }))

type Ledger = Record<string, { kind: "trade" | "swap" | "launch" | "stake"; body: unknown; result: unknown }>
const ledger = (): Ledger => (existsSync(ledgerPath) ? (JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger) : {})
function remember(id: string, entry: Ledger[string]): void {
  writeFileSync(ledgerPath, JSON.stringify({ ...ledger(), [id]: entry }))
}

/** Under `anyMint`, what the ledger's live trades of a token net to (raw): the embedded wallet holds what it bought. */
function heldRaw(mint: string): bigint {
  let n = 0n
  for (const e of Object.values(ledger())) {
    const body = e.body as Record<string, unknown>
    if (e.kind !== "trade" || body.mint !== mint) continue
    const amounts = ((e.result as { api?: { amounts?: { actualOutRaw?: string; amountRaw?: string } } }).api?.amounts ?? {}) as { actualOutRaw?: string; amountRaw?: string }
    if (body.side === "buy") n += BigInt(amounts.actualOutRaw ?? "0")
    else n -= BigInt(amounts.amountRaw ?? "0")
  }
  return n > 0n ? n : 0n
}
const anyHeld = () =>
  script().anyMint
    ? [...new Set(Object.values(ledger()).filter((e) => e.kind === "trade").map((e) => String((e.body as Record<string, unknown>).mint)))]
        .filter((m) => m !== FAKE_MINTS.MOON && heldRaw(m) > 0n)
        .map((mint) => ({ chain: "solana", mint, amountRaw: heldRaw(mint).toString(), decimals: 6 }))
    : []

const text = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
})
/** The plan's caps, as the recorded tier read's plan table states them. */
function tierCaps(tier: "free" | "pro" | "max") {
  return {
    free: { rateLimitPerMin: 30, dailyLaunchCap: 5, uploadsPerMin: 10, linkedWallets: 0 },
    pro: { rateLimitPerMin: 300, dailyLaunchCap: 50, uploadsPerMin: 30, linkedWallets: 10 },
    max: { rateLimitPerMin: 600, dailyLaunchCap: 1000, uploadsPerMin: 60, linkedWallets: 1000 },
  }[tier]
}

const envelopeError = (code: string, message: string, retryable = false, more: Record<string, unknown> = {}) => ({
  success: false,
  error: { code, message, retryable, ...more },
})

const tokens = [
  { symbol: "MOON", mint: FAKE_MINTS.MOON, decimals: 6, quoteDecimals: 9, candleLaunched: true, quoteMint: SOL_MINT },
  { symbol: "PEPE", mint: FAKE_MINTS.PEPE, decimals: 6, quoteDecimals: 9, candleLaunched: false, quoteMint: SOL_MINT },
]
const twin = { symbol: "MOON", mint: MOON_TWIN, decimals: 6, quoteDecimals: 9, candleLaunched: false, quoteMint: SOL_MINT }
const marketTokens = () => (script().markets ?? []).map((m) => ({ symbol: m.symbol, mint: m.mint, decimals: 6, quoteDecimals: 9, candleLaunched: false, quoteMint: SOL_MINT }))
const SOLANA_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const anyToken = (mint: unknown) =>
  script().anyMint && typeof mint === "string" && SOLANA_MINT.test(mint) && !(mint in FAKE_PRICES_USD)
    ? { symbol: mint.slice(0, 4).toUpperCase(), mint, decimals: 6, quoteDecimals: 9, candleLaunched: false, quoteMint: SOL_MINT }
    : undefined
const token = (mint: unknown) => [...tokens, ...(script().heldTwin ? [twin] : []), ...marketTokens()].find((t) => t.mint === mint) ?? anyToken(mint)
const prices = (): Record<string, number> => new Proxy(knownPrices(), { get: (o, k) => (typeof k === "string" && !(k in o) && anyToken(k) ? script().anyMint!.priceUsd : o[k as string]) })
const knownPrices = (): Record<string, number> => ({
  ...FAKE_PRICES_USD,
  ...(script().heldTwin ? { [MOON_TWIN]: 0.0021 } : {}),
  ...Object.fromEntries((script().markets ?? []).map((m) => [m.mint, m.priceUsd])),
})
// GET /api/v1/agent/wallets/embedded (docs.candle.tv/developers/agent-wallets: the key's own permission rides
// along), as recorded: every key on the account reports the same wallets, denied keys included.
const wallets = () => ({
  success: true,
  account: FAKE_WALLET,
  username: "fake-agent",
  wallets: { solana: { address: FAKE_WALLET, delegated: true }, evm: { address: FAKE_EVM_WALLET, delegated: true } },
  embeddedWalletPermission: script().embeddedWalletPermission ?? "allowed",
})

// The prefix of the key this server was started with (src/shared/api-key.ts's rule, repeated so the
// fake stays standalone): `cndl_live_` or `cndl_test_`, then the random part's first 8 characters.
const ownPrefix = (process.env.CANDLE_API_KEY ?? "").replace(/^cndl_(live|test)_/, "").slice(0, 8)

// The lists' recorded shapes: each bucket's envelope and a row's fields, from
// Candle's real answer at limit 20 with no `fields`. Rows are the fake's own tokens in that shape.
type Rec = { answer: Record<string, unknown> }
const FEEDS: Record<string, Rec> = { new: feedNew, graduated: feedGraduated, onfire: feedOnFire, finalstretch: feedFinalStretch }
/** Fields every row carries whatever `fields` asks (recorded: chain, address and symbol always ride along). */
const FEED_ALWAYS = ["chain", "address", "symbol"]
/** Names `fields` refuses: rows carry them, but they aren't feed fields (recorded: "Unknown field: _creationTime"). */
const FEED_UNKNOWN = new Set(["_creationTime", "newSortAt"])

function feed(args: Record<string, unknown>) {
  const bucket = String(args.bucket ?? "")
  const recorded = FEEDS[bucket]
  if (!recorded || (bucket === "finalstretch" && script().finalStretch === "off")) return text(feedUnknownBucket.answer, true)
  const fields = typeof args.fields === "string" ? args.fields.split(",").filter(Boolean) : undefined
  const unknown = fields?.find((f) => FEED_UNKNOWN.has(f))
  if (unknown) return text({ ...feedUnknownField.answer, error: { ...(feedUnknownField.answer.error as object), message: `Unknown field: ${unknown}` } }, true)
  const { tokens: realRows, ...envelope } = recorded.answer as { tokens: Record<string, unknown>[] }
  const template = realRows[0] ?? {}
  const all = [...tokens, ...marketTokens()].map((t, i) => {
    const row: Record<string, unknown> = { ...template, chain: "solana", address: t.mint, symbol: t.symbol, name: t.symbol }
    // Final Stretch's rows often have no price or market cap (recorded); the others' always do.
    if ("priceUsd" in template || bucket !== "finalstretch") row.priceUsd = prices()[t.mint] ?? null
    if ("marketCap" in template || bucket !== "finalstretch") row.marketCap = 1_000_000
    // priceUsd and change1h (a percent) as the live feed sends them.
    if ("change1h" in template || bucket === "onfire") row.change1h = i % 2 ? -3.2 : 12.5
    return row
  })
  // The Feed pane asks for change1h on On Fire; the recorded list carries it.
  const rows = all
    .slice(0, Math.min(Number(args.limit ?? 200), 200))
    .map((row) => (fields ? Object.fromEntries(Object.entries(row).filter(([k]) => FEED_ALWAYS.includes(k) || fields.includes(k))) : row))
  const stale = bucket === "finalstretch" && script().finalStretch === "stale"
  return text({
    ...envelope,
    bucket,
    tokens: rows,
    matched: all.length,
    scanned: all.length,
    ...(typeof args.since_seq === "string" && bucket !== "finalstretch" ? { reset: true } : {}),
    ...(stale ? { stale: true, feed: { ...(envelope as { feed: object }).feed, ok: false } } : {}),
  })
}

/** A key's P&L: the script's, or the empty book of a key with no trades, in the recorded shape. */
function profilePnl(prefix: string) {
  const scripted = script().pnl?.[prefix]
  if (scripted) return text(scripted)
  return text({ ...emptyPnl.answer, keyPrefix: prefix })
}

/** A paper buy's quoted figures, spending SOL at the fake's prices. */
function paperBuy(mint: string, amount: string) {
  const spent = Number(amount)
  const tokenAmount = Math.floor(((spent * FAKE_PRICES_USD[SOL_MINT]!) / (prices()[mint] ?? 1)) * 1e6) / 1e6
  return { amountRaw: String(Math.round(spent * 1e9)), expectedOutRaw: String(Math.round(tokenAmount * 1e6)), tokenAmount }
}

/** A paper sell's quoted figures: tokens sold for SOL at the fake's prices. */
function paperSell(mint: string, amount: string) {
  const sol = (Number(amount) * (prices()[mint] ?? 1)) / FAKE_PRICES_USD[SOL_MINT]!
  return { tokenAmount: Number(amount), expectedOutRaw: String(Math.round(sol * 1e9)) }
}

function answer(name: string, args: Record<string, unknown>, behaviour: Behaviour) {
  switch (name) {
    case "candle_get_market":
    case "candle_resolve_token":
    case "candle_token_forensics": {
      // Base assets answer the market read too, as recorded for SOL (cli-agent-a-candle_get_market.json):
      // the core prices a card's spend asset this way.
      const base = { [SOL_MINT]: "SOL", [USDC_MINT]: "USDC" }[String(args.mint)]
      if (name === "candle_get_market" && base) {
        return text({
          success: true,
          market: { chain: "solana", mint: args.mint, lifecycle: "trading", buysOpen: true, sellsOpen: true, external: true, candleLaunched: false, venue: "jupiter", metadata: { name: base, symbol: base }, priceUsd: FAKE_PRICES_USD[String(args.mint)] },
        })
      }
      const t = token(args.mint)
      if (!t) return text(envelopeError("MARKET_NOT_FOUND", `No market for ${String(args.mint)}`, false, { routing: { reason: "token_unknown" }, discovery: { indexed: false } }), true)
      // docs.candle.tv/developers/agent-trading, "Token forensics": six flags, each with a status; the summary is
      // clear only if all six are. Under `forensics`, as recorded.
      if (name === "candle_token_forensics") {
        const clear = script().forensicsClear === true
        const flag = (status: string) => ({ status, value: null, source: "candle", checkedAt: "2026-10-26T00:00:00.000Z", detail: null })
        return text({
          success: true,
          forensics: {
            chain: "solana",
            mint: t.mint,
            safety: {
              summary: clear ? "clear" : "incomplete",
              flags: { mintAuthority: flag("clear"), freezeAuthority: flag("clear"), tokenExtensions: flag("clear"), lpLock: flag("clear"), sellability: flag(clear ? "clear" : "unknown"), liquidityDrain: flag("clear") },
            },
          },
        })
      }
      // docs.candle.tv/developers/market-state: one shape, under `market`. The real server also carries
      // `priceUsd`, `marketCap` and `liquidityUsd` there (recorded for SOL), which the docs don't list.
      return text({
        success: true,
        market: {
          chain: "solana",
          mint: t.mint,
          lifecycle: "trading",
          buysOpen: true,
          sellsOpen: true,
          quoteMint: t.quoteMint,
          candleLaunched: t.candleLaunched,
          ...(t.candleLaunched ? {} : { external: true }),
          launchpad: t.candleLaunched ? "candle" : "pump.fun",
          venue: t.candleLaunched ? "candle-curve" : "jupiter",
          trade: { endpoint: "POST /api/v1/trade/agent/quote", routable: true },
          // docs.candle.tv/developers/market-state: `decimals` rides along for a token Candle launched; the real
          // server leaves it out for an external one (recorded for SOL, and seen for other external tokens).
          ...(t.candleLaunched ? { decimals: t.decimals } : {}),
          quoteDecimals: t.quoteDecimals,
          metadata: { name: t.symbol, symbol: t.symbol },
          priceUsd: prices()[t.mint],
          marketCap: 1_000_000,
          liquidityUsd: 100_000,
        },
      })
    }
    case "candle_get_feed":
      return feed(args)
    case "candle_get_wallets":
      return text(wallets())
    case "candle_get_portfolio": {
      // The SDK's PortfolioResult at the pinned commit (getPortfolio's test).
      const unpriced = new Set(script().unpriced ?? [])
      return text({
        success: true,
        embedded: [
          {
            chain: "solana",
            address: FAKE_WALLET,
            lamports: FAKE_HOLDINGS.lamports,
            // No symbol on a token row: the real server sent none (so Positions showed the mint).
            tokens: [
              { chain: "solana", mint: FAKE_MINTS.MOON, amountRaw: FAKE_HOLDINGS.moonRaw, decimals: 6 },
              ...(script().heldTwin ? [{ chain: "solana", mint: MOON_TWIN, amountRaw: "5000000000", decimals: 6 }] : []),
              ...anyHeld(),
            ],
          },
        ],
        // Every TEE wallet on the account, whichever key it's bound to (the portfolio doesn't say).
        tee: (script().teeWallets ?? []).filter((w) => w.chain !== "hood").map((w) => ({ id: w.id, address: w.address, label: w.label ?? null, active: w.active ?? true, chain: "solana", lamports: w.lamports ?? "0", tokens: [] })),
        hood: {
          embedded: [{ address: FAKE_EVM_WALLET, chain: "hood", wei: "0", tokens: [] }],
          tee: (script().teeWallets ?? []).filter((w) => w.chain === "hood").map((w) => ({ id: w.id, address: w.address, ...(w.label ? { label: w.label } : {}), active: w.active ?? true, chain: "hood", wei: "0", tokens: [] })),
          unavailable: [],
          unpriced: 0,
          unpricedByReason: {},
        },
        prices: Object.fromEntries(
          Object.entries(prices()).map(([mint, priceUsd]) => [mint, { priceUsd: unpriced.has(mint) ? null : priceUsd, source: "fake" }]),
        ),
        unavailable: [],
        complete: script().walletsComplete !== false,
        walletsComplete: script().walletsComplete ?? true,
      })
    }
    case "candle_get_profile_wallets": {
      // GET /api/v1/agent/keys/<prefix>/wallets, as recorded: the TEE wallets bound to that
      // key under walletScope "selected" (every key's default); the embedded wallet is never listed.
      if (typeof args.keyPrefix !== "string") {
        return text(`MCP error -32602: Input validation error: Invalid arguments for tool ${name}: keyPrefix Required`, true)
      }
      const bound = (script().teeWallets ?? []).filter((w) => w.boundKeyPrefix === args.keyPrefix)
      return text({
        keyPrefix: args.keyPrefix,
        profileId: `fake-profileId-${args.keyPrefix === ownPrefix ? 1 : 2}`,
        walletScope: "selected",
        wallets: bound.map((w) => ({ address: w.address, assignedAt: 1_790_000_000_000, chain: w.chain === "hood" ? "evm" : "solana", ...(w.label ? { label: w.label } : {}), linkedWalletId: w.id, spendCapable: w.active ?? true })),
        scopeLimit: { max: 1000, rows: bound.length },
      })
    }
    case "candle_get_profile_pnl":
      // GET /api/v1/agent/keys/<prefix>/pnl as recorded: any key on the account reads any prefix,
      // and an unknown one answers an empty book, not an error.
      if (typeof args.keyPrefix !== "string") return text(`MCP error -32602: Input validation error: Invalid arguments for tool ${name}: keyPrefix Required`, true)
      return profilePnl(args.keyPrefix)
    case "candle_get_profile_trades": {
      if (typeof args.keyPrefix !== "string") return text(`MCP error -32602: Input validation error: Invalid arguments for tool ${name}: keyPrefix Required`, true)
      const rows = (script().trades?.[args.keyPrefix] ?? []).slice(0, Number(args.limit ?? 200))
      return text({ success: true, keyPrefix: args.keyPrefix, trades: rows })
    }
    case "candle_perps_markets": {
      // GET /api/v1/agent/perps/markets as recorded (Hyperliquid's main markets, numbers as strings).
      const answer = perpsMarkets.answer as { markets: unknown[] }
      return text({ ...answer, markets: answer.markets.slice(0, Number(args.limit ?? 50)) })
    }
    case "candle_execution_status":
      // agentic orchestrate.ts executionStatus: the wallets, tier and key-limit reads, bundled, cut to
      // the recorded fields the core reads (the real tier read also carries the plan table).
      return text({
        success: true,
        ready: !script().unreadable?.length,
        ...(script().unreadable?.length ? { unreadable: script().unreadable } : {}),
        wallets: wallets(),
        tier: { success: true, tier: script().tier ?? "pro", liveTier: script().tier ?? "pro", feeBps: script().feeBps ?? 50, tierCaps: tierCaps(script().tier ?? "pro") },
        limits: { success: true, keyLimits: null, txLimit: script().uncapped ? null : { usdMicros: 100_000_000, reset: "daily" }, teeReadiness: { txLimit: !script().uncapped, rawCaps: { SOL: false, USDC: false } } },
      })
    case "candle_get_operation": {
      // GET /api/v1/trade/agent/jobs/:clientTradeId, relayed as `{ success, job }` (the SDK's TradeJob);
      // kind launch reads /launch/headless/jobs/:clientLaunchId (docs.candle.tv/developers/headless-launch).
      const entry = ledger()[String(args.clientId)]
      if (entry && entry.kind === "launch" && args.kind === "launch") {
        return text({ success: true, job: { clientLaunchId: args.clientId, chain: "solana", status: "confirmed", mint: LAUNCHED_MINT, signature: `SigFake${String(args.clientId).slice(0, 8)}` } })
      }
      // A paper trade writes no ledger row (docs.candle.tv/developers/agent-trading, "Paper mode"), so it is never found.
      if (!entry || entry.kind !== args.kind) {
        return text(
          {
            ...envelopeError("JOB_NOT_FOUND", `No ${String(args.kind)} with that clientTradeId for this account`, false),
            outcome: "unknown",
            next: `No ${String(args.kind)} record under id "${String(args.clientId)}" yet. That does not prove the write did not run. If a write was sent with this id, send the SAME request again with the SAME id.`,
          },
          true,
        )
      }
      return text({ success: true, job: { clientTradeId: args.clientId, status: "confirmed", signature: `SigFake${String(args.clientId).slice(0, 8)}` } })
    }
    case "candle_trade": {
      const id = String(args.clientTradeId ?? crypto.randomUUID())
      /**
       * A live fill's amounts and fee, in the shape the passes recorded (api.amounts, api.fee): what was sent, what
       * the quote said and what the chain delivered, at the fake's prices, with no slippage. A token it doesn't know
       * gets the old empty answer.
       */
      const liveAmounts = (a: Record<string, unknown>) => {
        const t = token(a.mint)
        const tokenUsd = prices()[String(a.mint)]
        const solUsd = FAKE_PRICES_USD[SOL_MINT]!
        const bps = script().feeBps ?? 50
        if (!t || !tokenUsd) return { fee: { bps }, amounts: {} }
        const raw = (n: number, d: number) => BigInt(Math.max(0, Math.floor(n * 10 ** d))).toString()
        if (a.side === "buy") {
          const sol = Number(a.amount ?? 0)
          const out = raw((sol * solUsd) / tokenUsd, t.decimals)
          return { fee: { bps, feeRaw: raw((sol * bps) / 10_000, 9) }, amounts: { quoteAsset: "sol", amountRaw: raw(sol, 9), expectedOutRaw: out, minOutRaw: out, actualOutRaw: out } }
        }
        const balance = script().anyMint && a.mint !== FAKE_MINTS.MOON ? heldRaw(String(a.mint)) : BigInt(FAKE_HOLDINGS.moonRaw)
        const tokensRaw = a.percent !== undefined ? ((balance * BigInt(Number(a.percent))) / 100n).toString() : raw(Number(a.amount ?? 0), t.decimals)
        const sol = ((Number(tokensRaw) / 10 ** t.decimals) * tokenUsd) / solUsd
        const out = raw(sol, 9)
        return { fee: { bps, feeRaw: raw((sol * bps) / 10_000, 9) }, amounts: { quoteAsset: "sol", amountRaw: tokensRaw, expectedOutRaw: out, minOutRaw: out, actualOutRaw: out } }
      }
      const stored = ledger()[id]
      if (stored) return text(stored.result)
      const paper = args.paper === true || behaviour === "sell-to-paper"
      // agentic orchestrate.ts, executeTrade: a live sell by amount converts with the market's decimals,
      // which an external token doesn't report; a live sell by percent reads the raw balance instead.
      if (!paper && args.side === "sell" && args.amount !== undefined && !token(args.mint)?.candleLaunched) {
        return text({ clientTradeId: id, success: false, error: { code: "MCP_VALIDATION", message: `could not resolve decimals for mint ${String(args.mint)}; pass a raw-ready amount via the SDK instead` } }, true)
      }
      // docs.candle.tv/developers/agent-trading: a main payer's "executed" response; a paper one carries
      // `paper: true` at the top level and writes no ledger row (its fields as recorded).
      const api = paper
        ? {
            success: true,
            paper: true,
            clientTradeId: id,
            chain: "solana",
            side: args.side,
            mint: args.mint,
            quoteAsset: "sol",
            // As recorded: what was spent, and what the quote said would come back.
            ...(args.side === "buy" ? paperBuy(String(args.mint), String(args.amount ?? "0")) : {}),
            // A sell by amount: what the quote said would come back, in SOL (Candle's paper keeps no balance to take a percent of).
            ...(args.side === "sell" && args.amount !== undefined ? paperSell(String(args.mint), String(args.amount)) : {}),
            feeBps: script().feeBps ?? 50,
            venue: "jupiter",
            tokenDecimals: 6,
            replay: false,
            note: "Recorded from the quote. No order was placed, and no money moved.",
          }
        : { success: true, status: "executed", clientTradeId: id, chain: "solana", signature: `SigFake${id.slice(0, 8)}`, ...liveAmounts(args) }
      const resolved =
        behaviour === "sell-to-paper"
          ? { percent: args.percent }
          : args.percent !== undefined && !paper && args.mint === FAKE_MINTS.MOON
            ? { percent: args.percent, balanceRaw: FAKE_HOLDINGS.moonRaw, amountRaw: ((BigInt(FAKE_HOLDINGS.moonRaw) * BigInt(Number(args.percent))) / 100n).toString() }
            : { amountDecimal: args.amount }
      const result = { clientTradeId: id, resolved, api }
      if (!paper) remember(id, { kind: "trade", body: args, result })
      return text(result)
    }
    case "candle_swap": {
      const id = String(args.clientSwapId ?? crypto.randomUUID())
      const stored = ledger()[id]
      if (stored) return text(stored.result)
      const result = { clientSwapId: id, success: true, payload: { from: args.from, to: args.to, hashes: [`SigFake${id.slice(0, 8)}`] } }
      remember(id, { kind: "swap", body: args, result })
      return text(result)
    }
    case "candle_launch_token":
    case "candle_launch_and_seed": {
      const id = String(args.clientLaunchId ?? crypto.randomUUID())
      // The headless dry run's body (docs.candle.tv/developers/headless-launch, "Dry run"); candle_launch_and_seed wraps it.
      if (args.dryRun === true) {
        const quote = String(args.quoteAsset ?? "sol")
        const dry = {
          success: true,
          dryRun: true,
          launchWallet: FAKE_WALLET,
          resolved: { chain: "solana", quoteAsset: quote, mode: args.mode ?? "open", stakerAllocationBps: 50, dexVersion: null, visibility: "production", buyAmount: "0" },
          curveTerms: { symbol: quote.toUpperCase(), thresholdRaw: "80000000000", raise: 80, startFdv: 0, bondingFdv: 0, supplySoldPct: 80, firstBuy: { basis: "reference", amountRaw: "1000000000", curveFeeRaw: "0", tokensOutRaw: "0", supplyPct: 1.25 } },
          devBuyMax: "500000000",
          checks: { image: "ok" },
          matrixVersion: 1,
        }
        return text(name === "candle_launch_token" ? dry : { clientLaunchId: id, dryRun: true, api: dry })
      }
      const stored = ledger()[id]
      if (stored) return text(stored.result)
      const launch = { success: true, chain: "solana", mint: LAUNCHED_MINT, pool: "PoolFake1111111111111111111111111111111111", signature: `SigFake${id.slice(0, 8)}`, quoteAsset: "sol", mode: "open" }
      const result = name === "candle_launch_token" ? launch : { clientLaunchId: id, launch, market: null, note: "the fake reads no market" }
      remember(id, { kind: "launch", body: args, result })
      return text(result)
    }
    case "candle_stake":
    case "candle_unstake":
    case "candle_finish_unstake": {
      // POST /api/v1/agent/staking/<action>/build (docs.candle.tv/developers/agent-trading, "CNDL staking"): the
      // embedded wallet's build is signed and sent by Candle; a replay resolves the saved transaction.
      const action = name === "candle_stake" ? "stake" : name === "candle_unstake" ? "unstake" : "finish"
      const id = String(args.clientStakeId)
      const op = { success: true, action, payer: args.payer ?? "main", wallet: FAKE_WALLET, clientStakeId: id, ...(action === "finish" ? { withdrawal: args.withdrawal } : { amountRaw: args.amountRaw }) }
      if (args.dryRun === true) return text({ ...op, dryRun: true, figures: { networkFeeLamports: "5000", priorityFeeLamports: "0", rentLamports: "2039280", reserveLamports: "0", requiredLamports: "2044280", balanceLamports: FAKE_HOLDINGS.lamports, creates: [] } })
      const stored = ledger()[id]
      if (stored) return text({ ...(stored.result as object), replay: true })
      const result = { ...op, dryRun: false, replay: false, status: "confirmed", signature: `SigFake${id.slice(0, 8)}`, builtAt: 1_790_000_000_000, lastValidBlockHeight: 1, warnings: [] }
      remember(id, { kind: "stake", body: args, result })
      return text(result)
    }
    case "candle_get_staking":
      // GET /api/v1/agent/staking (the SDK's StakingPositions).
      return text({
        success: true,
        pool: { withdrawalTimelockSeconds: 604_800, paused: false, maxActiveWithdrawals: 10 },
        wallets: [
          {
            payer: "main",
            address: FAKE_WALLET,
            cndl: { mint: CNDL_MINT, decimals: 6, amountRaw: "500000000" },
            staked: { mint: "SCndlFake111111111111111111111111111111111", decimals: 6, amountRaw: "250000000", cndlValueRaw: "260000000" },
            pendingWithdrawalRaw: "40000000",
            withdrawals: { active: [{ withdrawal: "WdFake1", amountRaw: "40000000", startTime: "2026-10-01T00:00:00.000Z", endTime: "2026-10-08T00:00:00.000Z", claimable: true }], finished: [] },
            unclaimedRewards: [{ rewardId: "rw_fake_1", mint: CNDL_MINT, symbol: "CNDL", name: "Candle", amountRaw: "12500000", distributedAt: null, claiming: false }],
          },
        ],
        notes: [],
      })
    case "candle_get_fees":
      return text({ success: true, tokens: [{ mint: FAKE_MINTS.MOON, chain: "solana", symbol: "MOON", name: "MOON", recipient: FAKE_WALLET, claimable: true, claimableAmounts: [{ symbol: "SOL", mint: SOL_MINT, decimals: 9, amountRaw: "1250000" }] }], isDone: true, continueCursor: null })
    case "candle_claim_fees": {
      // POST /api/v1/agent/fees/:mint/claim (docs.candle.tv/developers/claims, "What a claim returns").
      const dry = args.dryRun === true
      return text({ success: true, mint: args.mint, chain: "solana", dryRun: dry, recipient: FAKE_WALLET, ...(dry ? { claimable: true } : {}), claimed: [{ symbol: "SOL", mint: SOL_MINT, decimals: 9, amountRaw: "1250000", txHash: dry ? null : "SigFakeFee" }], remaining: [], warnings: [] })
    }
    case "candle_claim_staking_reward":
      return text({ success: true, rewardId: args.rewardId, owner: FAKE_WALLET, mint: CNDL_MINT, amountRaw: "12500000", signature: `SigFake${String(args.rewardId).slice(0, 8)}` })
    case "candle_update_profile":
      return text({ success: true, profileId: "fake-profileId-1", updated: Object.keys(args) })
    case "candle_create_post":
      return text({ profileId: "fake-profileId-1", post: { id: "post_fake_1", text: args.text, createdAt: 1_790_000_000_000, token: args.token ?? null } })
    case "candle_delete_post":
      return text({ profileId: "fake-profileId-1", postId: args.postId })
    default:
      return text(envelopeError("FAKE_NOT_SCRIPTED", `The fake doesn't answer ${name}`), true)
  }
}

if (script().startError) {
  process.stderr.write(`${script().startError!.replace("$KEY", process.env.CANDLE_API_KEY ?? "")}\n`)
  process.exit(1)
}

const server = new Server({ name: "candle-mcp", version: script().version ?? fixture.serverInfo.version }, { capabilities: { tools: { listChanged: true } } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: fixture.tools
    .filter((t) => !("listedAfterKeyCheck" in t))
    .map(({ listedAfterKeyCheck: _l, ...t }: { listedAfterKeyCheck?: boolean } & (typeof fixture.tools)[number]) => ({ ...t, inputSchema: t.inputSchema as { type: "object" } })),
}))

/** Each call's time over the last minute, for `rateLimitPerMin`: this process serves one key. */
const recentCalls: number[] = []
function overLimit(limit: number | undefined, requests: number): boolean {
  const now = Date.now()
  while (recentCalls.length && now - recentCalls[0]! >= 60_000) recentCalls.shift()
  if (limit === undefined || recentCalls.length + requests <= limit) {
    for (let i = 0; i < requests; i++) recentCalls.push(now)
    return false
  }
  return true
}

/** The breaker's state for this key: each trade's time over the last minute, a stop, and failed sells of each token in a row. */
const breakerTrades: number[] = []
let breakerStopped: string | undefined
const failedRun = new Map<string, number>()
/** A trade the breaker refuses, with why, or what it does to a sell of a token set to fail. */
function breakerAnswer(args: Record<string, unknown>): { stop: string } | { fail: true } | undefined {
  const breaker = script().breaker
  if (!breaker) return undefined
  if (breakerStopped) return { stop: breakerStopped }
  const now = Date.now()
  while (breakerTrades.length && now - breakerTrades[0]! >= 60_000) breakerTrades.shift()
  breakerTrades.push(now)
  if (breakerTrades.length >= 30) {
    breakerStopped = "Circuit breaker: 30 trades inside a minute. This profile is stopped until an account owner resumes it."
    appendFileSync(join(dir!, "fake-candle-calls.jsonl"), `${JSON.stringify({ name: "breaker", args: { why: "pace" }, at: now })}\n`)
    return { stop: breakerStopped }
  }
  const mint = String(args.mint)
  if (args.side === "sell" && breaker.failSells?.includes(mint)) {
    const run = (failedRun.get(mint) ?? 0) + 1
    failedRun.set(mint, run)
    if (run >= 3) {
      breakerStopped = `Circuit breaker: three failed sells of ${mint} in a row. This profile is stopped until an account owner resumes it.`
      appendFileSync(join(dir!, "fake-candle-calls.jsonl"), `${JSON.stringify({ name: "breaker", args: { why: "failed_sells", mint }, at: now })}\n`)
    }
    return { fail: true }
  }
  if (args.side === "sell") failedRun.delete(mint)
  return undefined
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name
  const args = (request.params.arguments ?? {}) as Record<string, unknown>
  // As Candle counts it: some tools make several requests against the key (requestsOf, measured against Candle's real server),
  // and a token's market read makes none (40 in a minute on a Free key, all answered).
  const limited = overLimit(script().rateLimitPerMin, name === "candle_get_market" ? 0 : requestsOf(name))
  appendFileSync(join(dir, "fake-candle-calls.jsonl"), `${JSON.stringify({ name, args, at: Date.now(), ...(limited ? { limited } : {}) })}\n`)
  if (limited) {
    const error = envelopeError("RATE_LIMITED", "Rate limit exceeded for this key. Try again shortly.", true)
    return name === "candle_trade" ? text({ clientTradeId: args.clientTradeId, resolved: {}, api: error }, true) : text(error, true)
  }
  if (name === "candle_trade" && args.side === "sell" && (script().sellDelayMs ?? 0) > 0) await Bun.sleep(script().sellDelayMs!)
  if (name === "candle_trade") {
    const b = breakerAnswer(args)
    if (b && "stop" in b) return text({ clientTradeId: args.clientTradeId, resolved: {}, api: envelopeError("RISK_LIMIT_REACHED", b.stop, false) }, true)
    if (b) return text({ clientTradeId: args.clientTradeId, resolved: {}, api: envelopeError("TRADE_REVERTED", "The trade landed and reverted on chain.", false, { stage: "reverted" }) }, true)
  }
  const behaviour = script().tools?.[name] ?? "ok"
  if (behaviour === "die") process.exit(1)
  if (behaviour === "die-once") {
    const marker = join(dir, `fake-candle-died-${name}`)
    if (!existsSync(marker)) {
      writeFileSync(marker, "")
      process.exit(1)
    }
  }
  if (behaviour === "hang") return new Promise<never>(() => {})
  if (behaviour === "transport") {
    const idKey = name === "candle_swap" ? "clientSwapId" : name.startsWith("candle_launch") ? "clientLaunchId" : name.includes("stake") ? "clientStakeId" : "clientTradeId"
    return text({ [idKey]: args[idKey], ...envelopeError("MCP_TRANSPORT", "The request failed in transit (fetch failed).", true) }, true)
  }
  if (behaviour === "validation-text") return text(`MCP error -32602: Input validation error: Invalid arguments for tool ${name}`, true)
  if (behaviour === "throw-text") return text("fetch failed", true)
  if (behaviour === "garbled") return text("<html>502 Bad Gateway</html>")
  if (typeof behaviour === "object") {
    const { refuse, retryable = false, stage, extra = {} } = behaviour
    const error = envelopeError(refuse, `Refused: ${refuse}`, retryable, { ...(stage ? { stage } : {}), ...extra })
    return name === "candle_trade" ? text({ clientTradeId: args.clientTradeId, resolved: {}, api: error }, true) : text(error, true)
  }
  return answer(name, args, behaviour)
})

const delay = script().initializeDelayMs ?? 0
if (delay > 0) await Bun.sleep(delay) // stdin waits in the pipe, so initialize is answered late
await server.connect(new StdioServerTransport())
