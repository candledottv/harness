// A TEE wallet's trades and swaps through `candle swap`. Pins seven rules: the TEE route never trades
// twice (every unclear answer is unknown and read back under the same id, and re-send runs the same argv);
// exit codes are read honestly; the hash binds the argv, the wallet, the agent and the mode; one agent
// can't pay from another's wallet; paper means paper; the kill switch; and limits.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupHomes, prefixedKey, startTestCore, until } from "../../test/core-fixture"
import { Redactor } from "../shared/redact"
import type { AgentStatus } from "./agent-status"
import { type Payable, resolvePayer, type TeeWallet } from "./agent-wallets"
import { BASE_ASSETS } from "./assets"
import type { CliResult } from "./candle-cli"
import { type Card, CardBook, type CardBookDeps, hashCard } from "./cards"
import type { Mode } from "./classify"
import { CliTrades, mapCliTrade, PRE_BUILD_CODES, swapJobState, weiAsEth } from "./cli-trade"
import { Operations } from "./execute"
import { readFill } from "./fill"
import { Journal } from "./journal"
import { KillSwitch } from "./kill"
import { DaySpend, Limits } from "./limits"
import type { MarketInfo } from "./markets"
import type { TradeRead } from "./reconcile"
import { sessionNote, TradeLog } from "./trade-log"
import type { FaceClient } from "./tool-face"

const MOON = "MoonFake11111111111111111111111111111111111"
const RIFT = "RiftFake11111111111111111111111111111111111"
const EMBEDDED = "WalletFake111111111111111111111111111111111"
const TEE_A = "TeeFakeA11111111111111111111111111111111111"
const TEE_B = "TeeFakeB11111111111111111111111111111111111"
const SOL = BASE_ASSETS.SOL.priceKey!
const T0 = Date.parse("2026-10-27T12:00:00Z")
const HARNESS: FaceClient = { clientId: "h1", role: "harness", agent: "momentum" }
const RPC = "https://rpc.example.invalid"

const dirs: string[] = []
const journals: Journal[] = []
const books: CardBook[] = []
afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close().catch(() => {})
  for (const book of books.splice(0)) book.stop()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
afterAll(() => cleanupHomes())

async function openJournal(now: () => number) {
  const dir = await mkdtemp(join(tmpdir(), "ctee-one-"))
  dirs.push(dir)
  const journal = await Journal.open({ path: join(dir, "journal.jsonl"), redactor: new Redactor(), account: "acct_fake", now })
  journals.push(journal)
  return { dir, journal }
}

const teeA: TeeWallet = { id: "teeA", address: TEE_A, label: "tee-one", chain: "solana", active: true }
const teeB: TeeWallet = { id: "teeB", address: TEE_B, label: "swing-tee", chain: "solana", active: true }

const HOODIE = "0x" + "4d".repeat(20)
const HOOD_TEE: TeeWallet = { id: "teeH", address: "0x00000000000000000000000000000000000E7e01", label: "hood-tee", chain: "hood", active: true }
const markets: Record<string, MarketInfo> = {
  [MOON]: { chain: "solana", mint: MOON, symbol: "MOON", candleLaunched: true, quoteMint: SOL, decimals: 6 },
  // A token Candle didn't launch: its market read reports no decimals (docs.candle.tv/developers/market-state).
  [RIFT]: { chain: "solana", mint: RIFT, symbol: "RIFT", candleLaunched: false },
  [HOODIE]: { chain: "hood", mint: HOODIE, symbol: "HOODIE", candleLaunched: false },
}

async function cardSetup(opts: { tee?: Record<string, TeeWallet[]>; embedded?: Record<string, "allowed" | "denied">; tier?: string; defaults?: Record<string, string>; holdings?: Record<string, bigint> } = {}) {
  let now = T0
  const { journal } = await openJournal(() => now)
  const tee = opts.tee ?? { momentum: [teeA], swing: [teeB] }
  const statusOf = (agent: string): AgentStatus => ({ readAt: 0, wallets: { solana: EMBEDDED }, embeddedWallet: opts.embedded?.[agent] ?? "allowed", feeBps: 25, unreadable: [], ...(opts.tier ? { tier: opts.tier } : {}) })
  const payable = (agent: string): Payable => ({
    ...(statusOf(agent).embeddedWallet === "allowed" ? { embedded: { address: EMBEDDED, chain: "solana" as const } } : {}),
    tee: tee[agent] ?? [],
    readAt: 0,
    unreadable: [],
    ...(opts.tier ? { tier: opts.tier } : {}),
  })
  const all = Object.values(tee).flat()
  const spend = new DaySpend()
  let mode: Mode = "live"
  let paused = false
  const holdingsRead: string[] = []
  const quotes: string[] = []
  const deps: CardBookDeps = {
    journal,
    account: "acct_fake",
    now: () => now,
    mode: () => mode,
    agents: () => ["momentum", "swing"],
    keyPrefix: (agent) => `${agent.slice(0, 4)}Ab3d`,
    status: { get: (agent) => statusOf(agent) },
    markets: { resolve: async (_agent, mint) => (markets[mint] ? { ok: true, market: markets[mint]! } : { ok: false, code: "MARKET_NOT_FOUND", message: "no market" }) },
    pricing: {
      asset: async (_a, asset) => (asset === "SOL" ? { usd: 150, at: now, source: "test" } : asset === "USDC" ? { usd: 1, at: now, source: "test" } : undefined),
      token: async (_a, _c, mint) => (mint === MOON ? { usd: 0.5, at: now, source: "test" } : mint === RIFT ? { usd: 0.01, at: now, source: "test" } : undefined),
      // Candle's quote is for the embedded payer: a TEE card never asks for one.
      quote: async (_a, trade) => (quotes.push(trade.mint), undefined),
    },
    spendAsset: () => "SOL",
    holding: async (_agent, wallet, mint) => {
      holdingsRead.push(`${wallet}:${mint}`)
      const raw = opts.holdings?.[mint]
      return raw === undefined ? "none" : { amountRaw: raw, decimals: 6 }
    },
    limits: new Limits({ limitsFor: () => ({ perTradeUsd: 10, perDayUsd: 50 }), spend }),
    spend,
    paused: () => paused,
    wallets: {
      payer: (agent, word, o) =>
        resolvePayer(
          { agent, payable: payable(agent), embeddedWallet: statusOf(agent).embeddedWallet, prefix: `${agent.slice(0, 4)}Ab3d`, account: all, boundTo: (a) => Object.keys(tee).find((k) => tee[k]!.some((w) => w.address === a)), ...(opts.defaults?.[agent] ? { defaultWallet: opts.defaults[agent] } : {}), ...(o?.chain ? { chain: o.chain } : {}) },
          word,
        ),
    },
    cliArgs: (args, o) => [...args, "--json", ...(o?.rpcUrl === false ? [] : ["--rpc-url", RPC])],
    execute: async () => ({ state: "submitting" as const }),
  }
  const book = new CardBook(deps)
  books.push(book)
  const propose = (args: Record<string, unknown>, tool = "candle_trade", client = HARNESS) =>
    book.propose({ client, agent: client.agent, tool, args, params: args, kind: tool === "candle_swap" ? "swap" : "trade", idKey: tool === "candle_swap" ? "clientSwapId" : "clientTradeId" })
  return { book, journal, spend, holdingsRead, quotes, propose, setMode: (m: Mode) => (mode = m), setPaused: (p: boolean) => (paused = p), tick: (ms: number) => (now += ms) }
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string; details?: Record<string, unknown> }> {
  try {
    await p
  } catch (error) {
    return error as { code: string; message: string }
  }
  throw new Error("expected a refusal")
}

const argvOf = (card: Card) => (card.params as { argv: string[] }).argv

describe("a TEE card's argv", () => {
  test("a buy: swap <spend asset> <mint> --amount, the wallet by address, the core's id, --yes, --json and the config's --rpc-url", async () => {
    const s = await cardSetup()
    const card = await s.propose({ mint: MOON, side: "buy", amount: "0.04", wallet: "tee-one" })
    expect(card.route).toBe("cli")
    expect(card.params).toEqual({ argv: ["swap", "SOL", MOON, "--amount", "0.04", "--wallet", TEE_A, "--client-trade-id", card.opId, "--yes", "--json", "--rpc-url", RPC], identity: "agent", agent: "momentum", json: true })
    expect(card.wallet).toBe(TEE_A)
    expect(card.display.walletLabel).toBe("tee-one")
    expect(card.display.paysFrom).toBe("pays from tee-one (TEE · TeeF…1111)")
    expect(card.display.resendNote).toContain("never sends it twice")
    expect(s.quotes).toEqual([])
  })

  test("a percent sell: swap <mint> <settlement asset> --percent, valued from the TEE wallet's own holding", async () => {
    const s = await cardSetup({ holdings: { [MOON]: 20_000_000n } })
    const card = await s.propose({ mint: MOON, side: "sell", percent: 50, wallet: TEE_A })
    expect(argvOf(card).slice(0, 5)).toEqual(["swap", MOON, "SOL", "--percent", "50"])
    expect(s.holdingsRead).toEqual([`${TEE_A}:${MOON}`])
    expect(card.display.sells).toEqual({ amount: 10, asset: "MOON" })
  })

  test("a Hood TEE wallet's buy: swap ETH <0x token> --amount, the wallet by address, and no Solana RPC", async () => {
    const s = await cardSetup({ tee: { momentum: [HOOD_TEE] } })
    const card = await s.propose({ mint: HOODIE, side: "buy", amount: "0.00047", wallet: "hood-tee" })
    expect(card.route).toBe("cli")
    expect(card.chain).toBe("hood")
    expect(card.params).toEqual({ argv: ["swap", "ETH", HOODIE, "--amount", "0.00047", "--wallet", HOOD_TEE.address, "--client-trade-id", card.opId, "--yes", "--json"], identity: "agent", agent: "momentum", json: true })
    expect(card.wallet).toBe(HOOD_TEE.address)
    expect(card.display.walletLabel).toBe("hood-tee")
    // Named by address in any case, it's the same wallet and the same argv.
    const again = await s.propose({ mint: HOODIE, side: "buy", amount: "0.0005", wallet: HOOD_TEE.address.toLowerCase() })
    expect(argvOf(again).slice(0, 7)).toEqual(["swap", "ETH", HOODIE, "--amount", "0.0005", "--wallet", HOOD_TEE.address])
  })

  test("a Hood TEE wallet's percent sell: swap <0x token> ETH --percent", async () => {
    const s = await cardSetup({ tee: { momentum: [HOOD_TEE] }, holdings: { [HOODIE]: 22_241_349_318_215_453_756_701n } })
    const card = await s.propose({ mint: HOODIE, side: "sell", percent: 100, wallet: "hood-tee" })
    expect(s.holdingsRead).toEqual([`${HOOD_TEE.address}:${HOODIE}`])
    expect(argvOf(card)).toEqual(["swap", HOODIE, "ETH", "--percent", "100", "--wallet", HOOD_TEE.address, "--client-trade-id", card.opId, "--yes", "--json"])
  })

  test("an amount sell of a token whose market read has no decimals goes out (the CLI reads them from the chain)", async () => {
    const s = await cardSetup()
    const card = await s.propose({ mint: RIFT, side: "sell", amount: "1500", wallet: "tee-one" })
    expect(argvOf(card).slice(0, 5)).toEqual(["swap", RIFT, "SOL", "--amount", "1500"])
    expect(card.value.usd).toBeCloseTo(15)
  })

  test("a dollar buy is converted when proposed, and the converted amount is what runs", async () => {
    const s = await cardSetup()
    const card = await s.propose({ mint: MOON, side: "buy", amountUsd: "3", wallet: "tee-one" })
    expect(argvOf(card).slice(0, 5)).toEqual(["swap", "SOL", MOON, "--amount", "0.02"])
    expect(card.display.headline).toBe("BUY $3.00 of MOON")
  })

  test("a swap, with amountRaw turned into a decimal, and the agent's slippage", async () => {
    const s = await cardSetup()
    const card = await s.propose({ from: "SOL", to: "USDC", amountRaw: "20000000", maxSlippageBps: 80, wallet: "tee-one" }, "candle_swap")
    expect(argvOf(card)).toEqual(["swap", "SOL", "USDC", "--amount", "0.02", "--wallet", TEE_A, "--client-trade-id", card.opId, "--slippage-bps", "80", "--yes", "--json", "--rpc-url", RPC])
  })

  test("the default wallet: a key denied the embedded wallet with one TEE wallet pays from it unnamed; a default names it", async () => {
    const denied = await cardSetup({ embedded: { momentum: "denied" } })
    expect((await denied.propose({ mint: MOON, side: "buy", amount: "0.01" })).wallet).toBe(TEE_A)
    const defaulted = await cardSetup({ defaults: { momentum: "tee-one" } })
    expect((await defaulted.propose({ mint: MOON, side: "buy", amount: "0.01" })).route).toBe("cli")
    // Unnamed and allowed the embedded wallet: the fast path, an MCP card with no `wallet` sent to Candle.
    const plain = await cardSetup()
    const card = await plain.propose({ mint: MOON, side: "buy", amount: "0.01" })
    expect(card.route).toBeUndefined()
    expect(card.params).toEqual({ mint: MOON, side: "buy", amount: "0.01", clientTradeId: card.opId })
    const named = await plain.propose({ mint: MOON, side: "buy", amount: "0.02", wallet: "embedded" })
    expect(named.params.wallet).toBeUndefined()
  })
})

describe("the hash binds what runs", () => {
  test("changing the argv, the wallet, the agent or the mode after proposal refuses the press", async () => {
    const changes: [string, (c: Card) => void][] = [
      ["argv", (c) => ((c.params as { argv: string[] }).argv[4] = "4")],
      ["wallet", (c) => (c.wallet = TEE_B)],
      ["agent", (c) => (c.agent = "swing")],
    ]
    for (const [what, change] of changes) {
      const s = await cardSetup()
      const card = await s.propose({ mint: MOON, side: "buy", amount: "0.04", wallet: "tee-one" })
      change(card)
      expect(`${what}: ${(await refusal(s.book.approve("v1", card.cardId, card.cardHash))).code}`).toBe(`${what}: CARD_CHANGED`)
    }
    const s = await cardSetup()
    const card = await s.propose({ mint: MOON, side: "buy", amount: "0.04", wallet: "tee-one" })
    s.setMode("paper")
    expect((await refusal(s.book.approve("v1", card.cardId, card.cardHash))).code).toBe("CARD_CHANGED")
  })

  test("a label never reaches the argv or the hash: the same wallet by label or address is the same card", async () => {
    const s = await cardSetup()
    const byLabel = await s.propose({ mint: MOON, side: "buy", amount: "0.04", wallet: "tee-one" })
    expect(argvOf(byLabel).join(" ")).not.toContain("tee-one")
    const recomputed = hashCard({ kind: "trade", tool: "candle_trade", params: byLabel.params, opId: byLabel.opId, account: "acct_fake", agent: "momentum", wallet: TEE_A, mode: "live", route: "cli" })
    expect(recomputed).toBe(byLabel.cardHash)
    expect(JSON.stringify(s.journal.rows().find((r) => r.type === "card.created")!.params)).not.toContain("tee-one")
  })
})

describe("refused when proposed, nothing sent", () => {
  test("another agent's TEE wallet, naming who holds it and what this agent can pay from", async () => {
    const s = await cardSetup()
    const r = await refusal(s.propose({ mint: MOON, side: "buy", amount: "0.04", wallet: "swing-tee" }))
    expect(r.code).toBe("WALLET_NOT_PAYABLE")
    expect(r.message).toContain("bound to swing's key")
    expect(r.message).toContain("It can pay from: embedded, tee-one.")
    expect(r.details?.canPayFrom).toEqual(["embedded", "tee-one"])
  })

  test("Free, an inactive TEE wallet, a Hood TEE wallet for a Solana token", async () => {
    const free = await cardSetup({ tier: "free" })
    expect((await refusal(free.propose({ mint: MOON, side: "buy", amount: "0.04", wallet: "tee-one" }))).code).toBe("TEE_TIER_REQUIRED")
    const inactive = await cardSetup({ tee: { momentum: [{ ...teeA, active: false }] } })
    expect((await refusal(inactive.propose({ mint: MOON, side: "buy", amount: "0.04", wallet: "tee-one" }))).code).toBe("TEE_WALLET_INACTIVE")
    const hood = await cardSetup({ tee: { momentum: [HOOD_TEE] } })
    expect((await refusal(hood.propose({ mint: MOON, side: "buy", amount: "0.04", wallet: "hood-tee" }))).code).toBe("WRONG_CHAIN")
  })

  test("paper mode, whatever the agent's paper says", async () => {
    const s = await cardSetup()
    s.setMode("paper")
    const r = await refusal(s.propose({ mint: MOON, side: "buy", amount: "0.04", wallet: "tee-one" }))
    expect(r).toMatchObject({ code: "NO_PAPER_TEE" })
    expect(r.message).toContain("no paper form")
  })

  test("a TEE buy or swap while paused; a TEE sell still proposes", async () => {
    const s = await cardSetup({ holdings: { [MOON]: 1_000_000n } })
    s.setPaused(true)
    expect((await refusal(s.propose({ mint: MOON, side: "buy", amount: "0.04", wallet: "tee-one" }))).code).toBe("PAUSED")
    expect((await refusal(s.propose({ from: "SOL", to: "USDC", amount: "0.02", wallet: "tee-one" }, "candle_swap"))).code).toBe("PAUSED")
    expect((await s.propose({ mint: MOON, side: "sell", percent: 100, wallet: "tee-one" })).route).toBe("cli")
  })

  test("a swap across chains (SOL to ETH) is a bridge, refused here and named: it has a card of its own", async () => {
    const s = await cardSetup()
    expect((await refusal(s.propose({ from: "SOL", to: "ETH", amount: "0.02", wallet: "tee-one" }, "candle_swap"))).code).toBe("USE_BRIDGE")
  })

  test("over a Candle Harness limit, with the numbers; TEE buys count beside embedded ones, and sells aren't limited", async () => {
    const s = await cardSetup({ holdings: { [MOON]: 1_000_000_000n } })
    const over = await refusal(s.propose({ mint: MOON, side: "buy", amount: "0.1", wallet: "tee-one" }))
    expect(over.code).toBe("OVER_TRADE_LIMIT")
    expect(over.message).toContain("$10")
    // About $9 at a time from the embedded wallet and from the TEE wallet: one day's spend, together.
    for (let i = 0; i < 2; i++) {
      const e = await s.propose({ mint: MOON, side: "buy", amount: `0.059${i}` })
      await s.book.approve("v1", e.cardId, e.cardHash)
      const t = await s.propose({ mint: MOON, side: "buy", amount: `0.058${i}`, wallet: "tee-one" })
      await s.book.approve("v1", t.cardId, t.cardHash)
    }
    const last = await s.propose({ mint: MOON, side: "buy", amount: "0.06" })
    await s.book.approve("v1", last.cardId, last.cardHash)
    expect(s.spend.spent("momentum", T0)).toBeGreaterThan(44)
    expect((await refusal(s.propose({ mint: MOON, side: "buy", amount: "0.05", wallet: "tee-one" }))).code).toBe("OVER_DAY_LIMIT")
    expect((await s.propose({ mint: MOON, side: "sell", percent: 100, wallet: "tee-one" })).route).toBe("cli")
  })
})

describe("paying from another wallet (a wallet chip in ctrl-o details)", () => {
  test("an embedded card proposed again from a TEE wallet: a new card with a new hash, and the old one withdrawn", async () => {
    const s = await cardSetup()
    const old = await s.propose({ mint: MOON, side: "buy", amount: "0.04" })
    expect(old.wallet).toBe(EMBEDDED)
    const fresh = await s.book.requote("v1", old.cardId, { wallet: TEE_A })
    expect(fresh.cardId).not.toBe(old.cardId)
    expect(fresh.cardHash).not.toBe(old.cardHash)
    expect(fresh).toMatchObject({ state: "awaiting_approval", wallet: TEE_A, route: "cli", agent: "momentum", origin: { clientId: "h1" } })
    expect(argvOf(fresh)).toContain(TEE_A)
    expect(fresh.display.paysFrom).toBe("pays from tee-one (TEE · TeeF…1111)")
    expect(s.book.get(old.cardId)!.state).toBe("withdrawn")
    expect(s.journal.rows().find((r) => r.type === "card.withdrawn")).toMatchObject({ cardId: old.cardId, by: "v1", reason: "paid_from_another_wallet", replacedBy: fresh.cardId })
  })

  test("a TEE card proposed again from the embedded wallet, and an expired card from another wallet", async () => {
    const s = await cardSetup()
    const tee = await s.propose({ from: "SOL", to: "USDC", amount: "0.02", wallet: "tee-one" }, "candle_swap")
    const embedded = await s.book.requote("v1", tee.cardId, { wallet: "embedded" })
    expect(embedded).toMatchObject({ wallet: EMBEDDED, tool: "candle_swap" })
    expect(embedded.route).toBeUndefined()
    expect(s.book.get(tee.cardId)!.state).toBe("withdrawn")
    s.tick(60_000)
    await s.book.expireDue()
    expect(s.book.get(embedded.cardId)!.state).toBe("expired")
    expect((await s.book.requote("v1", embedded.cardId, { wallet: TEE_A })).wallet).toBe(TEE_A)
  })

  test("a card approved while its new card was being made runs as it was, and no second card is left open", async () => {
    const s = await cardSetup()
    const old = await s.propose({ mint: MOON, side: "buy", amount: "0.04" })
    // The press lands while the fresh card is being priced.
    const real = s.book.propose.bind(s.book)
    s.book.propose = async (input) => {
      if (input.replaces === old.cardId) await s.book.approve("v1", old.cardId, old.cardHash)
      return real(input)
    }
    const r = await refusal(s.book.requote("v1", old.cardId, { wallet: TEE_A }))
    expect(r.code).toBe("CARD_ALREADY_APPROVED")
    expect(r.message).toContain("no new card was made")
    expect(s.book.get(old.cardId)!.state).toBe("approved")
    expect(s.book.list().filter((c) => c.state === "awaiting_approval")).toEqual([])
    expect(s.journal.rows().find((row) => row.type === "card.withdrawn")).toMatchObject({ reason: "original_approved" })
  })

  test("a wallet the agent can't pay from is refused with the core's words, and the old card stays open", async () => {
    const s = await cardSetup()
    const old = await s.propose({ mint: MOON, side: "buy", amount: "0.04" })
    const r = await refusal(s.book.requote("v1", old.cardId, { wallet: TEE_B }))
    expect(r.code).toBe("WALLET_NOT_PAYABLE")
    expect(r.message).toContain("It can pay from: embedded, tee-one.")
    expect(s.book.get(old.cardId)!.state).toBe("awaiting_approval")
    expect((await refusal(s.book.requote("v1", old.cardId, { wallet: 7 }))).code).toBe("INVALID_PARAMS")
  })

  test("paused, a buy isn't proposed again from any wallet; the old card stays to reject", async () => {
    const s = await cardSetup()
    const old = await s.propose({ mint: MOON, side: "buy", amount: "0.04" })
    s.setPaused(true)
    expect((await refusal(s.book.requote("v1", old.cardId, { wallet: TEE_A }))).code).toBe("PAUSED")
    expect(s.book.get(old.cardId)!.state).toBe("awaiting_approval")
  })

  test("an approved card can't be paid from another wallet; a card at the cap can", async () => {
    const s = await cardSetup()
    const cards = []
    for (const amount of ["0.01", "0.02", "0.03", "0.04", "0.05"]) cards.push(await s.propose({ mint: MOON, side: "buy", amount }))
    expect((await s.book.requote("v1", cards[0]!.cardId, { wallet: TEE_A })).wallet).toBe(TEE_A)
    await s.book.approve("v1", cards[1]!.cardId, cards[1]!.cardHash, "click")
    expect((await refusal(s.book.requote("v1", cards[1]!.cardId, { wallet: TEE_A }))).code).toBe("CARD_NOT_AWAITING")
  })
})

describe("outcome rules (mapCliTrade)", () => {
  const run = (exitCode: number, json: unknown, extra: Partial<CliResult> = {}) => ({ exitCode, json, timedOut: false, ...extra })
  const found = (job: Record<string, unknown>): TradeRead => ({ found: true, state: "pending", job })
  const none: TradeRead = { found: false, detail: "JOB_NOT_FOUND" }

  test("a Hood TEE wallet's refusals before anything is built are refused in words, never read back as unknown", () => {
    const wallet = "0x" + "7a".repeat(20)
    const gas = mapCliTrade(
      "trade",
      run(1, {
        code: "GAS_INSUFFICIENT",
        message: `This wallet's ETH does not cover the gas for every planned leg plus the sweep-home reserve (0.0000099 ETH). Shortfall: 0.000123456789 ETH. Fund it from the vault: candle vault fund ${wallet} --amount 0.000123456789 --asset ETH`,
        retryable: false,
        details: { shortfallWei: "123456789000000", requiredWei: "200000000000000", reserveWei: "9870000000000", balanceWei: "76543211000000" },
      }),
      none,
    )
    expect(gas.state).toBe("refused")
    expect(gas.error?.message).toBe(
      `This Hood TEE wallet doesn't hold enough ETH for the trade's gas and the reserve Candle keeps back to sweep it home (0.00000987 ETH): it's 0.000123456789 ETH short. Nothing was sent. Every trade from it pays gas in ETH, a USDG buy too. Send it ETH, or fund it from its vault key: candle vault fund ${wallet} --amount 0.000123456789 --asset ETH.`,
    )
    for (const code of ["WALLET_BUSY", "SEQUENCED_RAIL_REQUIRED", "CHAIN_MISMATCH", "RPC_FAILED", "PAIR_UNSUPPORTED", "QUOTE_EXPIRED"]) {
      const m = mapCliTrade("trade", run(1, { code, message: "This token settles in usdg, not ETH" }), none)
      expect([code, m.state]).toEqual([code, "refused"])
    }
    expect(mapCliTrade("trade", run(1, { code: "WALLET_BUSY", message: "This wallet is running sequenced operation op1" }), none).error?.message).toContain("Candle runs one at a time on a Hood TEE wallet")
    // Candle's guard on a transaction it couldn't settle: never "try again once it settles", which never comes by itself.
    const guarded = mapCliTrade("trade", run(1, { code: "WALLET_BUSY", message: "This wallet has an unresolved transaction (operation 5ef8256a-1176-4d36-aa6d-cce49b133eb2); it may have been broadcast. Do not repeat the trade; read the job status. Operation d76694a1-6a1c-4011-b914-af25c31b2fbb; use candle swap status d76694a1-6a1c-4011-b914-af25c31b2fbb before another attempt." }), none)
    expect(guarded.state).toBe("refused")
    expect(guarded.error?.message).toBe("Candle is holding this Hood TEE wallet for an earlier transaction it hasn't settled (its operation 5ef8256a-1176-4d36-aa6d-cce49b133eb2), and refuses every new trade from it until it does. Nothing was sent. If it lasts, Candle has to release it: give them that operation id.")
    expect(mapCliTrade("trade", run(1, { code: "PAIR_UNSUPPORTED", message: "This token settles in usdg, not ETH" }), none).error?.message).toContain("This token settles in usdg, not ETH")
    // At the submit, a leg may already have landed: what's under the id decides, and nothing found is unknown.
    const submit = mapCliTrade("trade", run(1, { code: "UNRECOGNIZED_TRANSACTION", message: "unrecognized" }), none)
    expect(submit.state).toBe("unknown")
    expect(submit.error?.message).toContain("didn't recognise a transaction Candle built")
    // A bare GAS_INSUFFICIENT with no figures still says what to do.
    expect(mapCliTrade("trade", run(1, { code: "GAS_INSUFFICIENT" }), none).error?.message).toContain("candle vault fund <its address> --asset ETH")
  })

  // Hood TEE answers in the shape candle swap --json gave live (CLI 0.13.19), with made-up hashes and addresses.
  const HOOD_WALLET = "0x00000000000000000000000000000000000E7e01"
  const TOKEN = "0x00000000000000000000000000000000000b0B01"
  const hash = (n: number) => `0x${String(n).repeat(64).slice(0, 64)}`
  const hoodBuy = {
    success: true,
    status: "executed",
    clientTradeId: "op-buy",
    chain: "hood",
    signature: hash(1),
    feeSignature: hash(2),
    fee: { bps: 25, feeRaw: "1175000000000", treasury: "0x0000000000000000000000000000000000000Fee" },
    amounts: { amountRaw: "470000000000000", expectedOutRaw: "22241349318215453756701", minOutRaw: "22130142571624376487917", quoteAsset: "eth", actualOutRaw: "22241349318215453756701", slippageBps: 0 },
    kind: "trade",
    wallet: HOOD_WALLET,
    operationId: "hood-op-1",
    landedLegs: [{ kind: "trade", hash: hash(1) }, { kind: "feeTransfer", hash: hash(2) }],
    signatures: [hash(1), hash(2)],
  }
  // The sell's answer has no actualOutRaw: what it received is the quote's.
  const hoodSell = {
    ...hoodBuy,
    clientTradeId: "op-sell",
    signature: hash(3),
    feeSignature: hash(4),
    fee: { bps: 25, feeRaw: "1105561218748" },
    amounts: { amountRaw: "22241349318215453756701", expectedOutRaw: "441626360486918", minOutRaw: "439418228684483", quoteAsset: "eth" },
    landedLegs: [{ kind: "permit2Approval", hash: hash(5) }, { kind: "trade", hash: hash(3) }, { kind: "feeTransfer", hash: hash(4) }],
  }

  test("a Hood TEE wallet's buy and sell: executed with the trade leg's signature is a fill, in ETH, never read with SOL's decimals", () => {
    expect(mapCliTrade("trade", run(0, hoodBuy))).toEqual({ state: "succeeded", result: hoodBuy })
    expect(mapCliTrade("trade", run(0, hoodSell))).toEqual({ state: "succeeded", result: hoodSell })
    expect(readFill({ side: "buy", mint: TOKEN, chain: "hood", wallet: HOOD_WALLET, result: hoodBuy })).toEqual({
      side: "buy",
      mint: TOKEN,
      chain: "hood",
      wallet: HOOD_WALLET,
      asset: "ETH",
      feeRaw: "1175000000000",
      tokensRaw: "22241349318215453756701",
      assetRaw: "470000000000000",
      measured: "chain",
    })
    expect(readFill({ side: "sell", mint: TOKEN, chain: "hood", wallet: HOOD_WALLET, result: hoodSell })).toMatchObject({ asset: "ETH", tokensRaw: "22241349318215453756701", assetRaw: "441626360486918", measured: "quote" })
  })

  test("a Hood sell that failed at its approval: the job's legs say what may have gone out, never Candle's \"No leg landed\" alone", () => {
    // As answered live: the approval had landed on chain, and Candle recorded it failed ("already known").
    const failed = { code: "SWAP_FAILED", message: "The approval leg failed: already known No leg landed. Operation hood-op-2; use candle swap status hood-op-2 before another attempt.", retryable: false }
    const job = (legs: { kind: string; status: string }[]) => ({ status: "failed", clientTradeId: "op-sell", chain: "hood", side: "sell", errorCode: "SWAP_FAILED", operation: { operationId: "hood-op-2", kind: "trade", status: "failed", plannedLegCount: legs.length, legs } })
    const atApproval = job([{ kind: "approval", status: "failed" }, { kind: "permit2Approval", status: "planned" }, { kind: "trade", status: "planned" }, { kind: "feeTransfer", status: "planned" }])
    const mapped = mapCliTrade("trade", run(1, failed), { found: true, state: "failed", job: atApproval })
    expect(mapped.state).toBe("failed")
    expect(mapped.error?.message).toStartWith("Nothing was traded. Candle stopped this Hood trade at its approval step, which may have landed")
    expect(mapped.error?.message).not.toContain("No leg landed")
    // The trade leg tried: it may have filled, so it's unknown and read again, never "nothing sent".
    const atTrade = job([{ kind: "approval", status: "landed" }, { kind: "permit2Approval", status: "landed" }, { kind: "trade", status: "failed" }, { kind: "feeTransfer", status: "planned" }])
    const unknown = mapCliTrade("trade", run(1, failed), { found: true, state: "unknown", job: atTrade })
    expect(unknown.state).toBe("unknown")
    expect(unknown.error?.message).toContain("it may have filled")
    // Nothing tried at all: refused, nothing sent.
    const none = job([{ kind: "approval", status: "planned" }, { kind: "trade", status: "planned" }])
    expect(mapCliTrade("trade", run(1, failed), { found: true, state: "refused", job: none }).state).toBe("refused")
  })

  test("wei as ETH, exactly", () => {
    expect([weiAsEth("1234500000000000"), weiAsEth("1000000000000000000"), weiAsEth("0"), weiAsEth("12345678901234567890"), weiAsEth("1.5")]).toEqual(["0.0012345", "1", "0", "12.34567890123456789", undefined])
  })

  test("exit 0 reads the body, never the exit code alone", () => {
    expect(mapCliTrade("trade", run(0, { success: true, status: "executed", signature: "S", kind: "trade" })).state).toBe("succeeded")
    expect(mapCliTrade("swap", run(0, { success: true, payload: { hashes: ["H"], settlement: { state: "settled" } }, settlement: { state: "settled" } })).state).toBe("succeeded")
    // A job the CLI found under the id, printed as it is: built and never signed is refused, never a fill,
    // and never left pending, since only the CLI could sign it and it didn't.
    const built = mapCliTrade("trade", run(0, { job: { status: "built" }, kind: "trade" }))
    expect(built.state).toBe("refused")
    expect(built.error?.code).toBe("BUILT_NOT_SENT")
    expect(mapCliTrade("swap", run(0, { job: { status: "built" }, kind: "swap" })).state).toBe("refused")
    // Built and signed may have gone: unknown, read back.
    expect(mapCliTrade("trade", run(0, { job: { status: "built", signature: "S" }, kind: "trade" })).state).toBe("unknown")
    expect(mapCliTrade("trade", run(0, { job: { status: "failed", signature: "S" }, kind: "trade" })).state).toBe("failed")
    expect(mapCliTrade("swap", run(0, { job: { status: "submitted", settlement: { state: "pending" } }, kind: "swap" })).state).toBe("pending")
    expect(mapCliTrade("swap", run(0, { success: true, payload: { hashes: ["H"] } })).state).toBe("unknown")
  })

  test("exit 0 in 0.13.11's shape (kind, status, signature and signatures added, the answer kept under raw) maps the same", () => {
    // As swap.ts swapJsonResult adds them for --json: additive, every earlier key where it was.
    const wrap = (r: Record<string, unknown>) => {
      const nested = (n: string) => (r[n] && typeof r[n] === "object" ? (r[n] as Record<string, unknown>) : {})
      const sources = [r, nested("payload"), nested("job")]
      const text = (v: unknown): v is string => typeof v === "string" && v.length > 0
      const signatures = [...new Set(sources.flatMap((s) => [s.signature, ...(Array.isArray(s.hashes) ? s.hashes : [])].filter(text)))]
      const status = [r.status, nested("job").status, nested("payload").status].find(text) ?? null
      return { ...r, kind: r.kind, status, clientTradeId: r.clientTradeId ?? null, signature: signatures[0] ?? null, signatures, raw: r }
    }
    const cases: [Parameters<typeof mapCliTrade>[0], Record<string, unknown>, string][] = [
      ["trade", { success: true, status: "executed", signature: "S", kind: "trade" }, "succeeded"],
      ["swap", { success: true, payload: { hashes: ["H"], settlement: { state: "settled" } }, settlement: { state: "settled" } }, "succeeded"],
      ["trade", { job: { status: "built" }, kind: "trade" }, "refused"],
      ["trade", { job: { status: "failed", signature: "S" }, kind: "trade" }, "failed"],
      ["swap", { job: { status: "submitted", settlement: { state: "pending" } }, kind: "swap" }, "pending"],
      ["swap", { success: true, payload: { hashes: ["H"] }, kind: "swap" }, "unknown"],
    ]
    for (const [kind, body, state] of cases) expect(`${kind} ${mapCliTrade(kind, run(0, wrap(body))).state}`).toBe(`${kind} ${state}`)
  })

  test("exit 1 with a pre-build code is refused only when nothing is under the id", () => {
    const r = mapCliTrade("trade", run(1, { ok: false, code: "TEE_WALLET_REQUIRED", message: "x. Operation abc; use candle swap status abc before another attempt." }), none)
    expect(r).toMatchObject({ state: "refused", error: { code: "TEE_WALLET_REQUIRED" } })
    // The CLI's advice to run swap status can't work from the user's terminal; the Candle Harness explains it.
    expect(r.error!.message).not.toContain("swap status")
    expect(mapCliTrade("trade", run(1, { ok: false, code: "SPEND_LIMIT_EXCEEDED" }), found({ status: "built" })).state).toBe("refused")
    expect(mapCliTrade("trade", run(1, { ok: false, code: "SPEND_LIMIT_EXCEEDED" }), found({ status: "confirmed", signature: "S" })).state).toBe("succeeded")
    // A read that failed says nothing about the write.
    expect(mapCliTrade("trade", run(1, { ok: false, code: "TEE_WALLET_REQUIRED" }), { found: false, detail: "unreadable" }).state).toBe("unknown")
  })

  test("exit 1 SWAP_FAILED from the build, with nothing under the id, is refused", () => {
    // As Candle answered a TEE buy its simulation refused: no details, nothing stored.
    const message = 'The composed input-fee swap transaction failed simulation ({"InstructionError":[9,{"Custom":6001}]}); retry with a fresh quote Operation abc; use candle swap status abc before another attempt.'
    const r = mapCliTrade("trade", run(1, { ok: false, code: "SWAP_FAILED", message }), none)
    expect(r).toMatchObject({ state: "refused", error: { code: "SWAP_FAILED" } })
    expect(r.error!.message).toStartWith("Candle refused it before anything was signed, so nothing was sent. The price moved more than the trade's slippage allows (Jupiter's code 6001; 0.5% unless a wider maxSlippageBps was set), so asking again quotes it fresh. Candle said: The composed input-fee swap")
    expect(r.error!.message).not.toContain("swap status")
    // Another simulation failure says only Candle's words.
    const other = mapCliTrade("trade", run(1, { ok: false, code: "SWAP_FAILED", message: 'failed simulation ({"InstructionError":[2,{"Custom":6024}]})' }), none)
    expect(other.error!.message).toBe('Candle refused it before anything was signed, so nothing was sent. Candle said: failed simulation ({"InstructionError":[2,{"Custom":6024}]})')
    // Anything from a submit keeps it unknown: a stage, a signature, the legs.
    expect(mapCliTrade("trade", run(1, { ok: false, code: "SWAP_FAILED", details: { stage: "executed", signature: "S" } }), none).state).toBe("unknown")
    expect(mapCliTrade("swap", run(1, { ok: false, code: "SWAP_FAILED", details: { legs: [] } }), none).state).toBe("unknown")
    expect(mapCliTrade("trade", run(1, { ok: false, code: "SWAP_FAILED", stage: "unconfirmed" }), none).state).toBe("unknown")
    // So does a read that failed, and something under the id decides as ever.
    expect(mapCliTrade("trade", run(1, { ok: false, code: "SWAP_FAILED" }), { found: false, detail: "unreadable" }).state).toBe("unknown")
    expect(mapCliTrade("trade", run(1, { ok: false, code: "SWAP_FAILED" }), found({ status: "confirmed", signature: "S" })).state).toBe("succeeded")
  })

  test("exit 1 REQUEST_FAILED (after signing) is unknown, and a job found settles it", () => {
    expect(PRE_BUILD_CODES.has("REQUEST_FAILED")).toBe(false)
    expect(mapCliTrade("trade", run(1, { ok: false, code: "REQUEST_FAILED" }), none)).toMatchObject({ state: "unknown" })
    expect(mapCliTrade("trade", run(1, { ok: false, code: "REQUEST_FAILED" }), found({ status: "confirmed", signature: "S" })).state).toBe("succeeded")
  })

  test("exit 3, OPERATION_ALREADY_STARTED, a timeout, a killed CLI and garbage are unknown", () => {
    expect(mapCliTrade("trade", run(3, { ok: false, code: "TRANSACTION_UNCONFIRMED" })).state).toBe("unknown")
    expect(mapCliTrade("trade", run(1, { ok: false, code: "OPERATION_ALREADY_STARTED" }), none).state).toBe("unknown")
    expect(mapCliTrade("trade", run(0, undefined, { timedOut: true })).state).toBe("unknown")
    expect(mapCliTrade("trade", run(137, undefined)).state).toBe("unknown")
    expect(mapCliTrade("trade", run(0, undefined, { jsonError: "Unexpected token" })).state).toBe("unknown")
  })

  test("a swap job by its settlement, then its status", () => {
    expect(swapJobState({ status: "submitted", settlement: { state: "settled" } })).toBe("succeeded")
    expect(swapJobState({ status: "submitted", settlement: { state: "failed" } })).toBe("failed")
    expect(swapJobState({ status: "submitted", settlement: { state: "uncertain" } })).toBe("pending")
    expect(swapJobState({ status: "built", signature: null })).toBe("pending")
    expect(swapJobState({ status: "failed", stage: "not_broadcast" })).toBe("refused")
    expect(swapJobState({ status: "submitted", stage: "unconfirmed", hashes: ["H"] })).toBe("unknown")
  })
})

/** Operations on the CLI route, with a scripted CLI and MCP read: what ran, in order. */
async function opsSetup(script: { runs: Partial<CliResult>[]; trades?: TradeRead[]; swaps?: TradeRead[]; loseNext?: boolean }) {
  let now = T0
  const { journal } = await openJournal(() => now)
  const ran: string[][] = []
  const timers: { run: () => Promise<void> | void; ms: number }[] = []
  const cli = {
    runExact: async (input: { argv: string[] }) => {
      ran.push(input.argv)
      if (input.argv[1] === "status") {
        const read = script.swaps?.shift() ?? { found: false, detail: "JOB_NOT_FOUND" }
        return { exitCode: read.found ? 0 : 1, stdout: "", stderr: "", json: read.found ? { job: read.job, kind: "swap" } : { ok: false, code: read.detail } } as CliResult
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...script.runs.shift() } as CliResult
    },
  }
  const reads: string[] = []
  const trades = new CliTrades({ cli, redactor: new Redactor(), journal, readTrade: async (_agent, opId) => (reads.push(opId), script.trades?.shift() ?? { found: false, detail: "JOB_NOT_FOUND" }) })
  const ops = new Operations({
    journal,
    pool: { for: () => ({ call: async () => ({ kind: "lost", reason: "timeout" }) }) },
    now: () => now,
    schedule: (run, ms) => {
      timers.push({ run, ms })
      return () => {}
    },
    cliTrades: trades,
    ...(script.loseNext ? { loseNextReply: true } : {}),
  })
  const tick = async () => {
    const next = timers.shift()
    if (!next) return false
    now += next.ms
    await next.run()
    return true
  }
  return { ops, journal, ran, reads, tick, timers }
}

const teeCard = (kind: "trade" | "swap", opId = "op-1"): Card =>
  ({
    cardId: `card-${opId}`,
    opId,
    kind,
    tool: kind === "swap" ? "candle_swap" : "candle_trade",
    agent: "momentum",
    mode: "live",
    route: "cli",
    wallet: TEE_A,
    expiresAt: new Date(T0 + 60_000).toISOString(),
    params: { argv: ["swap", "SOL", kind === "swap" ? "USDC" : MOON, "--amount", "0.04", "--wallet", TEE_A, "--client-trade-id", opId, "--yes", "--json"], identity: "agent", agent: "momentum", json: true },
  }) as unknown as Card

describe("the CLI route through Operations", () => {
  test("a fill settles at once, and the journal says the route and the wallet before the run", async () => {
    const s = await opsSetup({ runs: [{ json: { success: true, status: "executed", signature: "S" } }] })
    const op = await s.ops.execute(teeCard("trade"))
    expect(op.state).toBe("succeeded")
    expect(s.journal.rows().find((r) => r.type === "operation.submitting")).toMatchObject({ route: "cli", wallet: TEE_A })
  })

  test("a lost TEE trade is read back through candle_get_operation, settled, and never sent twice", async () => {
    const s = await opsSetup({ runs: [{ exitCode: 3, json: { ok: false, code: "TRANSACTION_UNCONFIRMED" } }], trades: [{ found: false, detail: "JOB_NOT_FOUND" }, { found: true, state: "succeeded", job: { status: "confirmed", signature: "S" } }] })
    const op = await s.ops.execute(teeCard("trade"))
    expect(op.state).toBe("unknown")
    while (await s.tick()) {}
    expect(op.state).toBe("succeeded")
    expect(s.reads).toEqual(["op-1", "op-1"])
    expect(s.ran.filter((a) => a[1] !== "status")).toHaveLength(1)
  })

  test("a Hood TEE trade that outlasts the CLI's 120 s is followed by its id while its legs land, never sent again", async () => {
    // Its legs run one after another; a read mid-way finds the job with some landed and the rest planned.
    const legs = (statuses: string[]) => ["approval", "permit2Approval", "trade", "feeTransfer"].map((kind, i) => ({ kind, status: statuses[i]! }))
    const midway = { status: "submitted", chain: "hood", operation: { status: "running", legs: legs(["landed", "landed", "submitted", "planned"]) } }
    const done = { status: "confirmed", chain: "hood", signature: "0x01", operation: { status: "completed", legs: legs(["landed", "landed", "landed", "landed"]) } }
    const s = await opsSetup({ runs: [{ exitCode: 124, timedOut: true, json: undefined }], trades: [{ found: true, state: "unknown", job: midway }, { found: true, state: "succeeded", job: done }] })
    const card = { ...teeCard("trade"), chain: "hood" as const, wallet: "0x00000000000000000000000000000000000E7e01" }
    const op = await s.ops.execute(card)
    expect(op.state).toBe("unknown")
    expect(op.reason).toBe("the candle CLI didn't finish in time")
    await s.tick()
    expect(op.state).toBe("unknown")
    while (await s.tick()) {}
    expect(op.state).toBe("succeeded")
    expect(s.ran.filter((a) => a[1] !== "status")).toHaveLength(1)
  })

  test("a lost TEE swap is read back by candle swap status with the same key, settled, and never sent twice", async () => {
    const s = await opsSetup({ runs: [{ exitCode: 1, json: { ok: false, code: "REQUEST_FAILED" } }], swaps: [{ found: false, detail: "JOB_NOT_FOUND" }, { found: true, state: "succeeded", job: { status: "submitted", settlement: { state: "settled" } } }] })
    const op = await s.ops.execute(teeCard("swap"))
    expect(op.state).toBe("unknown")
    while (await s.tick()) {}
    expect(op.state).toBe("succeeded")
    expect(s.ran.filter((a) => a[1] === "status")).toEqual([
      ["swap", "status", "op-1", "--kind", "swap", "--json"],
      ["swap", "status", "op-1", "--kind", "swap", "--json"],
    ])
    expect(s.ran.filter((a) => a[1] !== "status")).toHaveLength(1)
  })

  test("re-send runs the same argv under the same id, and settles from what the CLI finds", async () => {
    const s = await opsSetup({ runs: [{ exitCode: 3, json: { ok: false, code: "TRANSACTION_UNCONFIRMED" } }, { json: { job: { status: "confirmed", signature: "S" }, kind: "trade" } }] })
    const card = teeCard("trade")
    await s.ops.execute(card)
    const op = await s.ops.resolve("v1", "op-1", "resend")
    expect(op.state).toBe("succeeded")
    expect(s.ran).toEqual([(card.params as { argv: string[] }).argv, (card.params as { argv: string[] }).argv])
  })

  test("a restart mid-run turns it unknown, reads it back on the CLI route, and runs nothing", async () => {
    const s = await opsSetup({ runs: [], swaps: [{ found: true, state: "succeeded", job: { status: "submitted", settlement: { state: "settled" } } }] })
    await s.journal.append({ type: "operation.submitting", mode: "live", agent: "momentum", opId: "op-9", cardId: "card-9", kind: "swap", tool: "candle_swap", params: teeCard("swap", "op-9").params, cardExpiresAt: T0 + 60_000, route: "cli", wallet: TEE_A })
    const turned = await s.ops.rebuild(s.journal.rows())
    s.ops.readBack()
    expect(turned).toEqual(["op-9"])
    expect(s.ops.get("op-9")).toMatchObject({ state: "unknown", route: "cli", reason: "core_restarted" })
    await s.tick()
    expect(s.ops.get("op-9")!.state).toBe("succeeded")
    expect(s.ran).toEqual([["swap", "status", "op-9", "--kind", "swap", "--json"]])
  })

  test("the debug switch: the CLI runs, its answer is dropped once, and the read settles it", async () => {
    const s = await opsSetup({ runs: [{ json: { success: true, status: "executed", signature: "S" } }], trades: [{ found: true, state: "succeeded", job: { status: "confirmed", signature: "S" } }], loseNext: true })
    const op = await s.ops.execute(teeCard("trade"))
    expect(op).toMatchObject({ state: "unknown", reason: "no answer (transport)" })
    expect(s.ops.losingNextReply()).toBe(false)
    await s.tick()
    expect(op.state).toBe("succeeded")
    expect(s.ran).toHaveLength(1)
  })

  test("exit 1 with a pre-build code and nothing under the id is refused, after one read", async () => {
    const s = await opsSetup({ runs: [{ exitCode: 1, json: { ok: false, code: "SIGNER_UNAVAILABLE" } }] })
    const op = await s.ops.execute(teeCard("trade"))
    expect(op).toMatchObject({ state: "refused", error: { code: "SIGNER_UNAVAILABLE" } })
    expect(s.reads).toEqual(["op-1"])
    expect(s.timers).toHaveLength(0)
  })

  test("a USAGE answer is refused and logged as the Candle Harness's bug", async () => {
    const s = await opsSetup({ runs: [{ exitCode: 2, json: { ok: false, code: "USAGE", message: "Usage: …" } }] })
    const op = await s.ops.execute(teeCard("trade"))
    expect(op.state).toBe("refused")
    expect(s.journal.rows().some((r) => r.type === "core.bug")).toBe(true)
  })
})

describe("the kill switch and the session block", () => {
  test("kill withdraws a TEE buy, keeps a TEE sell, and offers candle tee disable for the agent's TEE wallet", async () => {
    const s = await cardSetup({ holdings: { [MOON]: 1_000_000n } })
    const buyCard = await s.propose({ mint: MOON, side: "buy", amount: "0.04", wallet: "tee-one" })
    const sellCard = await s.propose({ mint: MOON, side: "sell", percent: 100, wallet: "tee-one" })
    const dir = mkdtempSync(join(tmpdir(), "chrn-kill-"))
    dirs.push(dir)
    const kill = await KillSwitch.open({
      journal: s.journal,
      mode: () => "live",
      statePath: join(dir, "kill.json"),
      now: () => T0,
      agents: () => ["momentum"],
      cards: s.book,
      operations: { list: () => [] },
      engine: { cancelAll: async () => [] },
      spend: s.spend,
      limitsFor: () => ({ perDayUsd: 50 }),
      walletsOf: () => [EMBEDDED],
      portfolio: () => ({ result: { embedded: [{ address: EMBEDDED, lamports: "0", tokens: [] }], tee: [{ address: TEE_A, label: "tee-one", lamports: "0", tokens: [] }] }, readAt: T0 }),
      prices: { usd: () => undefined },
      keyPrefix: () => "momeAb3d",
      teeWallets: () => [teeA],
      publish: () => {},
      onChange: () => {},
    })
    const { report } = await kill.kill("v1")
    expect(s.book.get(buyCard.cardId)!.state).toBe("withdrawn")
    // The TEE sell is kept as a fresh card, the same trade from the same wallet; the old one withdrawn.
    expect(s.book.get(sellCard.cardId)!.state).toBe("withdrawn")
    expect(report.stillOpen).toHaveLength(1)
    const fresh = s.book.get(report.stillOpen[0]!.cardId)!
    expect(fresh).toMatchObject({ state: "awaiting_approval", side: "sell", route: "cli", wallet: TEE_A })
    expect(fresh.cardId).not.toBe(sellCard.cardId)
    expect(report.notStopped.steps[0]!.disableTee).toEqual([{ wallet: "tee-one", command: `candle tee disable ${TEE_A}` }])
    // Where it stands names the TEE wallet's agent too (it once had none).
    expect(report.standing.wallets.map((w) => [w.label, w.agents])).toEqual([
      [undefined, ["momentum"]],
      ["tee-one", ["momentum"]],
    ])
  })

  test("the session block and activity name the TEE wallet a trade paid from", async () => {
    const s = await cardSetup()
    const card = await s.propose({ mint: MOON, side: "buy", amount: "0.04", wallet: "tee-one" })
    const log = new TradeLog({ symbolOf: () => "MOON" })
    for (const row of s.journal.rows()) log.add(row)
    log.add({ seq: 99, at: new Date(T0).toISOString(), type: "operation.succeeded", mode: "live", agent: "momentum", opId: card.opId } as never)
    expect(sessionNote(log.sessionTrades(), {})).toContain("filled BUY 0.04 SOL of MOON from tee-one")
    expect(log.activity().at(-1)!.text).toBe("filled BUY 0.04 SOL of MOON from tee-one")
  })
})

describe("through a running core and the fake candle CLI", () => {
  test("a TEE buy the agent proposes runs candle swap with the agent's key, once, and fills", async () => {
    const cliDir = mkdtempSync(join(tmpdir(), "ctee-one-cli-"))
    dirs.push(cliDir)
    const tee = { id: "teeA", address: TEE_A, label: "tee-one", boundKeyPrefix: "Momentum" }
    writeFileSync(join(cliDir, "fake-cli.json"), JSON.stringify({ tee: { wallets: [tee] } }))
    const t = await startTestCore({ env: { ...process.env, CANDLE_CONFIG_DIR: cliDir } }, { keys: { momentum: prefixedKey("Momentum"), swing: prefixedKey("Swingkey") }, candle: { momentum: { teeWallets: [tee] }, swing: { teeWallets: [tee] } } })
    try {
      const view = await t.view()
      // `subscribe`, the protocol's method (this once called `events.subscribe`, which isn't one).
      expect((await view.request("subscribe", { topics: ["operations"] })).error).toBeUndefined()
      const { client } = await t.harness(view)
      const answer = (await client.request("tools.call", { name: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.01", wallet: "tee-one" } })).result as { content: { text: string }[] }
      const body = JSON.parse(answer.content[0]!.text) as { cardId: string }
      const card = t.core.cards.get(body.cardId)!
      expect(card).toMatchObject({ route: "cli", wallet: TEE_A })
      const approved = (await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })).result as { operation: { state: string } }
      expect(approved.operation.state).toBe("succeeded")
      const runs = readFileSync(join(cliDir, "fake-cli-runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string> })
      const swaps = runs.filter((r) => r.argv[0] === "swap" && r.argv[1] !== "status")
      expect(swaps).toHaveLength(1)
      expect(swaps[0]!.argv).toEqual(["swap", "SOL", MOON, "--amount", "0.01", "--wallet", TEE_A, "--client-trade-id", card.opId, "--yes", "--json"])
      expect(swaps[0]!.env.CANDLE_API_KEY).toBe(prefixedKey("Momentum"))
      await until(() => t.core.operations.get(card.opId)?.state === "succeeded")
      // The view hears it on the topic it subscribed to.
      await until(() => view.events.some((e) => e.topic === "operations" && (e.data as { opId?: string; state?: string }).opId === card.opId && (e.data as { state?: string }).state === "succeeded"))
    } finally {
      await t.close()
    }
  }, 30_000)
  async function hoodCore(swapOutcome?: string) {
    const cliDir = mkdtempSync(join(tmpdir(), "ctee-hood-cli-"))
    dirs.push(cliDir)
    const HOOD_ADDR = "0x00000000000000000000000000000000000E7e01"
    const TOKEN = "0x00000000000000000000000000000000000b0B01"
    const tee = { id: "teeH", address: HOOD_ADDR, label: "hood-tee", boundKeyPrefix: "Momentum", chain: "hood" as const }
    writeFileSync(join(cliDir, "fake-cli.json"), JSON.stringify({ tee: { wallets: [tee], ...(swapOutcome ? { swapOutcome } : {}) } }))
    const script = { teeWallets: [{ ...tee, wei: "2500000000000000" }], ethUsd: 2_100, markets: [{ mint: TOKEN, symbol: "HTOK", priceUsd: 0.0000443 }] }
    const t = await startTestCore({ env: { ...process.env, CANDLE_CONFIG_DIR: cliDir } }, { keys: { momentum: prefixedKey("Momentum"), swing: prefixedKey("Swingkey") }, candle: { momentum: script, swing: script } })
    const view = await t.view()
    const { client } = await t.harness(view)
    const swaps = () =>
      readFileSync(join(cliDir, "fake-cli-runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[] }).filter((r) => r.argv[0] === "swap" && r.argv[1] !== "status")
    const buy = async () => {
      const answer = (await client.request("tools.call", { name: "candle_trade", args: { mint: TOKEN, side: "buy", amount: "0.00047", wallet: "hood-tee" } })).result as { content: { text: string }[] }
      const card = t.core.cards.get((JSON.parse(answer.content[0]!.text) as { cardId: string }).cardId)!
      const approved = (await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })).result as { operation: { state: string } }
      return { card, approved }
    }
    return { t, HOOD_ADDR, TOKEN, swaps, buy }
  }

  test("a Hood TEE wallet's buy runs candle swap ETH <token> once, with no Solana RPC, and its fill is in ETH", async () => {
    const h = await hoodCore()
    try {
      const { card, approved } = await h.buy()
      expect(card).toMatchObject({ route: "cli", wallet: h.HOOD_ADDR, chain: "hood" })
      expect(approved.operation.state).toBe("succeeded")
      expect(h.swaps()).toHaveLength(1)
      expect(h.swaps()[0]!.argv).toEqual(["swap", "ETH", h.TOKEN, "--amount", "0.00047", "--wallet", h.HOOD_ADDR, "--client-trade-id", card.opId, "--yes", "--json"])
      const done = h.t.core.journal.rows().find((r) => r.type === "operation.succeeded" && r.opId === card.opId) as { fill?: Record<string, unknown> } | undefined
      expect(done?.fill).toMatchObject({ side: "buy", mint: h.TOKEN, chain: "hood", wallet: h.HOOD_ADDR, asset: "ETH", assetRaw: "470000000000000", tokensRaw: "22241349318215453756701", measured: "chain" })
    } finally {
      await h.t.close()
    }
  }, 30_000)

  test("a Hood TEE trade stopped at a leg, with nothing under its id yet, is unknown and read again: never \"nothing was sent\", never sent twice", async () => {
    const h = await hoodCore("approvalFailed")
    try {
      const { card } = await h.buy()
      await until(() => h.t.core.operations.get(card.opId)?.state === "unknown")
      const op = h.t.core.operations.get(card.opId)!
      expect(op.error?.message ?? "").not.toContain("nothing was sent")
      await Bun.sleep(300)
      expect(h.t.core.operations.get(card.opId)!.state).toBe("unknown")
      expect(h.swaps()).toHaveLength(1)
    } finally {
      await h.t.close()
    }
  }, 30_000)
})
