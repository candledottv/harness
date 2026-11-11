// A bridge between two of the account's own wallets: the card a person or an agent proposes, how it runs through the
// candle CLI (a TEE wallet's) or Candle's candle_swap (the embedded wallet's), how the core follows it to its end, the
// kill switch, and its records. Pins: both ends are the same key's TEE wallets or the account's two embedded wallets,
// and nothing else; it's always a card, live only; it's written down before it's sent, under one id, and never sent
// twice; a refund is said as a refund.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, until } from "../../test/core-fixture"
import { Redactor } from "../shared/redact"
import type { AgentStatus } from "./agent-status"
import { type Payable, resolvePayer, type TeeWallet } from "./agent-wallets"
import { BRIDGE_TOOL, bridgeArgs, bridgeMapped, bridgeStatusOf, landingBalance, mapCliBridge, nextBridgeReadMs, receivedWords } from "./bridge"
import { BASE_ASSETS } from "./assets"
import type { CliResult } from "./candle-cli"
import { CliTrades } from "./cli-trade"
import { Operations } from "./execute"
import { type Card, CardBook, type CardBookDeps } from "./cards"
import { classify, type Mode, pausedMessage, pausedStops } from "./classify"
import { Journal } from "./journal"
import { KillSwitch } from "./kill"
import { TradeLog } from "./trade-log"
import { DaySpend, Limits } from "./limits"
import type { FaceClient } from "./tool-face"
import type { ToolOutcome } from "./candle-mcp"

const EMBEDDED = "WalletFake111111111111111111111111111111111"
const EMBEDDED_EVM = "0x00000000000000000000000000000000000E3b01"
const TEE_SOL: TeeWallet = { id: "teeS", address: "TeeFakeA11111111111111111111111111111111111", label: "bot-1", chain: "solana", active: true }
const TEE_HOOD: TeeWallet = { id: "teeH", address: "0x00000000000000000000000000000000000E7e01", label: "bot-1-h", chain: "hood", active: true }
const TEE_HOOD_2: TeeWallet = { id: "teeH2", address: "0x00000000000000000000000000000000000E7e02", label: "bot-1-h2", chain: "hood", active: true }
const T0 = Date.parse("2026-11-10T12:00:00Z")
const HARNESS: FaceClient = { clientId: "h1", role: "harness", agent: "momentum" }

const dirs: string[] = []
const journals: Journal[] = []
const books: CardBook[] = []
afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close().catch(() => {})
  for (const book of books.splice(0)) book.stop()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
afterAll(() => cleanupHomes())

async function setup(opts: { tee?: TeeWallet[]; embedded?: "allowed" | "denied"; evm?: boolean } = {}) {
  let now = T0
  const dir = await mkdtemp(join(tmpdir(), "chrn-bridge-"))
  dirs.push(dir)
  const journal = await Journal.open({ path: join(dir, "journal.jsonl"), redactor: new Redactor(), account: "acct_fake", now: () => now })
  journals.push(journal)
  const tee = opts.tee ?? [TEE_SOL, TEE_HOOD]
  const status: AgentStatus = { readAt: 0, wallets: { solana: EMBEDDED, ...(opts.evm === false ? {} : { evm: EMBEDDED_EVM }) }, embeddedWallet: opts.embedded ?? "allowed", feeBps: 25, unreadable: [] }
  const payable = (): Payable => ({
    ...(status.embeddedWallet === "allowed" ? { embedded: { address: EMBEDDED, chain: "solana" as const } } : {}),
    ...(status.embeddedWallet === "allowed" && status.wallets.evm ? { embeddedEvm: status.wallets.evm } : {}),
    tee,
    readAt: 0,
    unreadable: [],
  })
  const spend = new DaySpend()
  let mode: Mode = "live"
  let paused = false
  const deps: CardBookDeps = {
    journal,
    account: "acct_fake",
    now: () => now,
    mode: () => mode,
    agents: () => ["momentum"],
    keyPrefix: () => "momeAb3d",
    status: { get: () => status },
    markets: { resolve: async () => ({ ok: false, code: "MARKET_NOT_FOUND", message: "no market" }) },
    pricing: {
      asset: async (_a, asset) => (asset === "SOL" ? { usd: 150, at: now, source: "test" } : asset === "ETH" ? { usd: 3000, at: now, source: "test" } : asset === "USDC" || asset === "USDG" ? { usd: 1, at: now, source: "test" } : undefined),
      token: async () => undefined,
      quote: async () => undefined,
    },
    spendAsset: () => "SOL",
    holding: async () => "none",
    limits: new Limits({ limitsFor: () => ({ perTradeUsd: 10, perDayUsd: 50 }), spend }),
    spend,
    paused: () => paused,
    wallets: {
      payer: (agent, word, o) => resolvePayer({ agent, payable: payable(), embeddedWallet: status.embeddedWallet, ...(status.wallets.evm ? { evm: status.wallets.evm } : {}), prefix: "momeAb3d", account: tee, boundTo: () => agent, ...(o?.chain ? { chain: o.chain } : {}) }, word),
      payable: () => payable(),
    },
    cliArgs: (args, o) => [...args, "--json", ...(o?.rpcUrl === false ? [] : ["--rpc-url", "https://rpc.example.invalid"])],
    execute: async () => ({ state: "submitting" as const }),
  }
  const book = new CardBook(deps)
  books.push(book)
  const propose = (args: Record<string, unknown>, client = HARNESS) => book.propose({ client, agent: client.agent, tool: "candle_bridge", args, params: args, kind: "bridge", idKey: "coreOpId" })
  return { book, journal, spend, propose, setMode: (m: Mode) => (mode = m), setPaused: (p: boolean) => (paused = p), tick: (ms: number) => (now += ms) }
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p
  } catch (error) {
    return error as { code: string; message: string }
  }
  throw new Error("expected a refusal")
}

const argvOf = (card: Card) => (card.params as { argv: string[] }).argv

describe("the tool", () => {
  test("candle_bridge is a card, live only: never read, never paper", () => {
    expect(classify("candle_bridge", { from: "SOL", to: "ETH", amount: "0.5" }, "live")).toEqual({ class: "card", kind: "bridge", idKey: "coreOpId" })
    expect(classify("candle_bridge", { from: "SOL", to: "ETH", amount: "0.5" }, "paper")).toMatchObject({ class: "refused", code: "NO_PAPER_FORM" })
  })

  test("its description says it's always a card, what it moves, between whose wallets, and that Candle charges no fee", () => {
    for (const words of ["between two of your own wallets", "always becomes an approval card", "Candle charges no fee", "isn't sending funds out", "needs ETH for gas"]) expect(BRIDGE_TOOL.description).toContain(words)
    expect(BRIDGE_TOOL.inputSchema.required).toEqual(["from", "to"])
  })

  test("the kill switch stops a bridge card, in words of its own", () => {
    expect(pausedStops({ kind: "bridge", tool: "candle_bridge" })).toBe(true)
    expect(pausedMessage({ kind: "bridge" })).toContain("Bridging is paused by the kill switch")
  })
})

describe("a TEE bridge's argv", () => {
  test("swap <from> <to>, the sizing, the sending wallet and the landing one by address, the core's id and --yes; never --wait", () => {
    expect(bridgeArgs({ from: "SOL", to: "ETH", sizing: { amount: "0.5" }, wallet: TEE_SOL.address, destination: TEE_HOOD.address, opId: "op-1" })).toEqual(["swap", "SOL", "ETH", "--amount", "0.5", "--wallet", TEE_SOL.address, "--to", TEE_HOOD.address, "--client-trade-id", "op-1", "--yes"])
    expect(bridgeArgs({ from: "USDG", to: "USDC", sizing: { percent: 50 }, wallet: TEE_HOOD.address, opId: "op-2" })).toEqual(["swap", "USDG", "USDC", "--percent", "50", "--wallet", TEE_HOOD.address, "--client-trade-id", "op-2", "--yes"])
  })
})

describe("the proposal", () => {
  test("from a TEE wallet: the CLI's argv to the same key's TEE wallet on the other chain, with --json and no --rpc-url, which would feed both chains' reads", async () => {
    const s = await setup()
    const card = await s.propose({ from: "SOL", to: "ETH", amount: "0.5", wallet: "bot-1" })
    expect(card.route).toBe("cli")
    expect(card.kind).toBe("bridge")
    expect(card.tool).toBe("candle_bridge")
    expect(argvOf(card)).toEqual(["swap", "SOL", "ETH", "--amount", "0.5", "--wallet", TEE_SOL.address, "--to", TEE_HOOD.address, "--client-trade-id", card.opId, "--yes", "--json"])
    expect(card.wallet).toBe(TEE_SOL.address)
    expect(card.chain).toBe("solana")
    // A move between the key's own wallets: no side, so no Candle Harness limit counts it and it never runs without a card.
    expect(card.side).toBeUndefined()
    expect(card.display.headline).toBe("BRIDGE 0.5 SOL → ETH")
    expect(card.display.valueUsd).toBe(75)
    expect(card.display.gets).toEqual({ amount: 0.025, asset: "ETH" })
    expect(card.display.bridge).toMatchObject({ route: "bot-1 · TEE (Solana) → bot-1-h · TEE (Hood)", via: "via Relay · less Relay's fee · no Candle fee · same key, not funds out", arriving: "sent on Solana · arriving on Hood…" })
    // The card's run keeps what its end is said with: what arrives, and where a refund goes.
    expect((card.params as { bridge?: unknown }).bridge).toEqual({ to: "ETH", fromName: "bot-1", toName: "bot-1-h" })
  })

  test("the default sending wallet on the asset's chain, and back from Hood, by percent", async () => {
    const s = await setup()
    const card = await s.propose({ from: "ETH", to: "SOL", percent: 50, wallet: "bot-1-h" })
    expect(argvOf(card)).toEqual(["swap", "ETH", "SOL", "--percent", "50", "--wallet", TEE_HOOD.address, "--to", TEE_SOL.address, "--client-trade-id", card.opId, "--yes", "--json"])
    expect(card.chain).toBe("hood")
    expect(card.display.headline).toBe("BRIDGE 50% of ETH → SOL")
    expect(card.display.bridge?.arriving).toBe("sent on Hood · arriving on Solana…")
  })

  test("with two TEE wallets on the other chain, the one it lands in is named, or the card says which there are", async () => {
    const s = await setup({ tee: [TEE_SOL, TEE_HOOD, TEE_HOOD_2] })
    const unnamed = await refusal(s.propose({ from: "SOL", to: "ETH", amount: "0.5", wallet: "bot-1" }))
    expect(unnamed.code).toBe("BRIDGE_DESTINATION_UNNAMED")
    expect(unnamed.message).toContain("bot-1-h, bot-1-h2")
    // Typed on the input line, the refusal says how to name it there, and suggests none of them: one may be held.
    expect(unnamed.message).toContain("add `into` and one of those names")
    expect(unnamed.message).not.toContain("`into bot-1-h")
    const card = await s.propose({ from: "SOL", to: "ETH", amount: "0.5", wallet: "bot-1", destination: "bot-1-h2" })
    expect(argvOf(card)).toContain(TEE_HOOD_2.address)
    // A destination that isn't one of the key's TEE wallets on the other chain is refused, never swapped for another.
    expect((await refusal(s.propose({ from: "SOL", to: "ETH", amount: "0.5", wallet: "bot-1", destination: "bot-1" }))).code).toBe("BRIDGE_DESTINATION_MISSING")
    expect((await refusal(s.propose({ from: "SOL", to: "ETH", amount: "0.5", wallet: "bot-1", destination: "0x00000000000000000000000000000000000E7e99" }))).code).toBe("BRIDGE_DESTINATION_MISSING")
  })

  test("a key with no active TEE wallet on the other chain can't bridge from its TEE wallet, and the card says how to get one", async () => {
    const s = await setup({ tee: [TEE_SOL, { ...TEE_HOOD, active: false }] })
    const r = await refusal(s.propose({ from: "SOL", to: "ETH", amount: "0.5", wallet: "bot-1" }))
    expect(r.code).toBe("BRIDGE_DESTINATION_MISSING")
    expect(r.message).toContain("no active Hood TEE wallet")
    expect(r.message).toContain("Nothing was sent")
  })

  test("from the embedded wallet: Candle's candle_swap between the account's embedded wallets, under the card's id", async () => {
    const s = await setup()
    const card = await s.propose({ from: "SOL", to: "ETH", amount: "0.5", wallet: "embedded" })
    expect(card.route).toBeUndefined()
    expect(card.params).toEqual({ from: "SOL", to: "ETH", amount: "0.5", clientSwapId: card.opId, bridge: { to: "ETH", fromName: "embedded", toName: "embedded on Hood" } })
    expect(card.wallet).toBe(EMBEDDED)
    expect(card.display.bridge).toMatchObject({ route: "embedded (Solana) → embedded (Hood)", via: "through Candle · less Relay's fee · no Candle fee · same account, not funds out" })
    // Its figure is a price conversion: what arrives is less Relay's fee, which can be a tenth of a small bridge.
    expect(card.display.receives).toContain("before Relay's fee comes off it")
  })

  test("the embedded wallet bridges an amount, never a percent, and only to the embedded wallet on the other chain", async () => {
    const s = await setup()
    expect((await refusal(s.propose({ from: "SOL", to: "ETH", percent: 50, wallet: "embedded" }))).code).toBe("INVALID_BRIDGE")
    expect((await refusal(s.propose({ from: "SOL", to: "ETH", amount: "0.5", wallet: "embedded", destination: "bot-1-h" }))).code).toBe("BRIDGE_ENDS")
    expect((await refusal(s.propose({ from: "SOL", to: "ETH", amount: "0.5", wallet: "bot-1", destination: "embedded" }))).code).toBe("BRIDGE_ENDS")
    // An account with no embedded wallet on the other chain has nowhere for it to land.
    const none = await setup({ evm: false })
    expect((await refusal(none.propose({ from: "SOL", to: "ETH", amount: "0.5", wallet: "embedded" }))).code).toBe("AGENT_WALLET_MISSING")
  })

  test("only SOL or USDC across to ETH or USDG, or back: a pair on one chain is a swap, and CNDL doesn't cross", async () => {
    const s = await setup()
    for (const args of [
      { from: "SOL", to: "USDC", amount: "1" },
      { from: "ETH", to: "USDG", amount: "1" },
      { from: "CNDL", to: "ETH", amount: "1" },
      { from: "SOL", to: "SOL", amount: "1" },
    ]) {
      expect((await refusal(s.propose({ ...args, wallet: "bot-1" }))).code).toBe("INVALID_BRIDGE")
    }
    expect((await refusal(s.propose({ from: "SOL", to: "ETH", wallet: "bot-1" }))).code).toBe("INVALID_BRIDGE")
    expect((await refusal(s.propose({ from: "SOL", to: "ETH", amount: "0.5", percent: 5, wallet: "bot-1" }))).code).toBe("INVALID_BRIDGE")
    expect((await refusal(s.propose({ from: "SOL", to: "ETH", percent: 150, wallet: "bot-1" }))).code).toBe("INVALID_BRIDGE")
    // An argument it doesn't take is refused by name.
    expect((await refusal(s.propose({ from: "SOL", to: "ETH", amount: "0.5", wallet: "bot-1", slippageBps: 50 })))).toMatchObject({ code: "UNKNOWN_ARGUMENT" })
  })

  test("while the kill switch is on, a bridge is refused before anything is read", async () => {
    const s = await setup()
    s.setPaused(true)
    const r = await refusal(s.propose({ from: "SOL", to: "ETH", amount: "0.5", wallet: "bot-1" }))
    expect(r.code).toBe("PAUSED")
    expect(r.message).toContain("Bridging is paused")
  })

  test("a bridge card lasts 60 s, as a trade's does", async () => {
    const s = await setup()
    const card = await s.propose({ from: "SOL", to: "ETH", amount: "0.5", wallet: "bot-1" })
    expect(Date.parse(card.expiresAt) - T0).toBe(60_000)
  })
})

describe("where a bridge stands", () => {
  const facts = { to: "ETH" as const, fromName: "bot-1", toName: "bot-1-h" }

  test("the CLI's bridgeStatus is read as it's given; with none, from the job as the CLI reads it", () => {
    expect(bridgeStatusOf({ job: { status: "submitted" }, bridgeStatus: { phase: "filling", open: "open", blockingUntil: 5 } })).toEqual({ phase: "filling", open: "open", blockingUntil: 5 })
    expect(bridgeStatusOf({ job: { settlement: { state: "settled", legs: [{ status: "confirmed" }], settledOutRaw: "313692000000000" } } })).toEqual({ phase: "filled", settledOutRaw: "313692000000000", landed: true })
    expect(bridgeStatusOf({ job: { settlement: { state: "pending", legs: [{ status: "confirmed" }] }, bridge: { state: "open", blockingUntil: 9 } } })).toEqual({ phase: "filling", open: "open", blockingUntil: 9, landed: true })
    expect(bridgeStatusOf({ job: { settlement: { state: "pending", legs: [{ status: "submitted" }] } } })?.phase).toBe("depositing")
    expect(bridgeStatusOf({ job: { status: "failed" } })?.phase).toBe("failed")
    expect(bridgeStatusOf({ job: { status: "built" } })?.phase).toBe("not_broadcast")
    expect(bridgeStatusOf({})).toBeUndefined()
  })

  test("filled is done, with what arrived in its own units", () => {
    expect(bridgeMapped({ phase: "filled", settledOutRaw: "313692000000000" }, { result: {}, facts, sent: true })).toMatchObject({ state: "succeeded", result: { received: "0.000313692 ETH" } })
  })

  test("failed after the deposit landed is a refund to the wallet it came from; before, nothing was bridged", () => {
    expect(bridgeMapped({ phase: "failed", landed: true }, { result: {}, facts, sent: true }).error?.message).toBe("The deposit landed and Relay didn't fill it: Relay refunds it to bot-1. Check that wallet's balance.")
    expect(bridgeMapped({ phase: "failed" }, { result: {}, facts, sent: true }).error?.message).toContain("nothing was bridged")
  })

  test("uncertain, or past its two hours, says where to look and isn't followed further; on its way, it's pending", () => {
    expect(bridgeMapped({ phase: "uncertain" }, { result: {}, facts, sent: true })).toMatchObject({ state: "unknown", error: { code: "BRIDGE_UNCERTAIN", message: expect.stringContaining("bot-1-h") } })
    expect(bridgeMapped({ phase: "filling", open: "uncertain" }, { result: {}, facts, sent: true })).toMatchObject({ state: "unknown", error: { code: "BRIDGE_PAST_TWO_HOURS" } })
    expect(bridgeMapped({ phase: "depositing", open: "open" }, { result: {}, facts, sent: true }).state).toBe("pending")
  })

  test("a deposit the core saw sent and Candle doesn't show yet is lag; one never sent, with nothing open, is refused", () => {
    expect(bridgeMapped({ phase: "not_broadcast" }, { result: {}, facts, sent: true }).state).toBe("pending")
    expect(bridgeMapped({ phase: "not_broadcast" }, { result: {}, facts, sent: false })).toMatchObject({ state: "refused", error: { code: "BRIDGE_NOT_SENT" } })
  })

  test("read every 10 s for ten minutes, then once a minute, until its two hours have passed", () => {
    expect(nextBridgeReadMs(T0, T0 + 1_000)).toBe(10_000)
    expect(nextBridgeReadMs(T0, T0 + 11 * 60_000)).toBe(60_000)
    expect(nextBridgeReadMs(T0, T0 + 2 * 60 * 60_000)).toBeUndefined()
  })
})

describe("a TEE bridge's run, read", () => {
  const facts = { to: "ETH" as const, fromName: "bot-1", toName: "bot-1-h" }
  const receipt = { success: true, kind: "swap", clientTradeId: "op-1", bridge: { from: "SOL", to: "ETH", destination: TEE_HOOD.address, depositHash: "5sig" }, quote: { venue: "relay", candleFee: "none", relayFees: "about $0.048 as Relay reports it", estimatedTime: "about 1s as Relay reports it", minimumReceived: "0.0003 ETH" } }

  test("the receipt (the deposit sent) is pending, and followed; a timeout or an unreadable answer is unknown, and read back", () => {
    expect(mapCliBridge({ exitCode: 0, json: receipt }, facts)).toMatchObject({ state: "pending", result: receipt })
    expect(mapCliBridge({ exitCode: 0, timedOut: true }, facts).state).toBe("unknown")
    expect(mapCliBridge({ exitCode: 0, jsonError: "bad" }, facts).state).toBe("unknown")
  })

  test("a rerun under the id prints what's there: filled is done, never sent again", () => {
    expect(mapCliBridge({ exitCode: 0, json: { kind: "swap", job: { status: "confirmed" }, bridgeStatus: { phase: "filled", settledOutRaw: "313692000000000" } } }, facts)).toMatchObject({ state: "succeeded", result: { received: "0.000313692 ETH" } })
  })

  test("refused before anything was signed, with nothing under the id: nothing was sent, in the Harness's words", () => {
    const missing = mapCliBridge({ exitCode: 1, json: { code: "BRIDGE_DESTINATION_MISSING", message: "This key has no active Hood TEE wallet to bridge into." } }, facts, { found: false, detail: "JOB_NOT_FOUND" })
    expect(missing).toMatchObject({ state: "refused", error: { code: "BRIDGE_DESTINATION_MISSING" } })
    expect(missing.error?.message).toContain("Nothing was sent")
    expect(mapCliBridge({ exitCode: 1, json: { code: "PAIR_UNSUPPORTED", message: "cross-chain swaps are not supported" } }, facts, { found: false, detail: "JOB_NOT_FOUND" })).toMatchObject({ state: "refused", error: { message: expect.stringContaining("cross-chain swaps aren't on") } })
  })

  test("an error after which the id shows a deposit is that deposit's state, never a refusal", () => {
    const read = { found: true as const, body: { kind: "swap", job: { status: "submitted" } }, status: { phase: "depositing" as const, open: "open" as const } }
    expect(mapCliBridge({ exitCode: 1, json: { code: "REQUEST_FAILED", message: "the submit failed" } }, facts, read).state).toBe("pending")
    // Exit 3 may have been sent: read back, never refused.
    expect(mapCliBridge({ exitCode: 3, json: { code: "UNCERTAIN" } }, facts).state).toBe("unknown")
    // A code the id can't be read for: unknown.
    expect(mapCliBridge({ exitCode: 1, json: { code: "REQUEST_FAILED" } }, facts, { found: false, detail: "unreadable" }).state).toBe("unknown")
  })
})

/** Operations with a scripted CLI and Candle child: what ran, in order, and the timers to drive by hand. */
async function opsSetup(script: { runs?: Partial<CliResult>[]; statuses?: (Record<string, unknown> | "missing")[]; mcp?: ToolOutcome[]; budget?: (agent: string, requests?: number) => boolean; landing?: (bigint | undefined)[] }) {
  let now = T0
  const dir = await mkdtemp(join(tmpdir(), "chrn-bridge-ops-"))
  dirs.push(dir)
  const journal = await Journal.open({ path: join(dir, "journal.jsonl"), redactor: new Redactor(), account: "acct_fake", now: () => now })
  journals.push(journal)
  const ran: string[][] = []
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  const timers: { run: () => Promise<void> | void; ms: number }[] = []
  const submittedBeforeRun: boolean[] = []
  const cli = {
    runExact: async (input: { argv: string[] }) => {
      ran.push(input.argv)
      if (input.argv[1] === "status") {
        const body = script.statuses?.shift() ?? "missing"
        return (body === "missing" ? { exitCode: 1, stdout: "", stderr: "", timedOut: false, json: { ok: false, code: "JOB_NOT_FOUND" } } : { exitCode: 0, stdout: "", stderr: "", timedOut: false, json: body }) as CliResult
      }
      submittedBeforeRun.push(journal.rows().some((r) => r.type === "operation.submitting"))
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...script.runs?.shift() } as CliResult
    },
  }
  const trades = new CliTrades({ cli, redactor: new Redactor(), journal, readTrade: async () => ({ found: false, detail: "JOB_NOT_FOUND" }) })
  /** Every read of a landing wallet's balance, in order with the calls to Candle. */
  const landingReads: number[] = []
  const ops = new Operations({
    journal,
    pool: { for: () => ({ call: async (tool: string, args: Record<string, unknown>) => (calls.push({ tool, args }), script.mcp?.shift() ?? { kind: "lost" as const, reason: "timeout" }) }) },
    ...(script.landing ? { bridgeLanding: async () => (landingReads.push(calls.length), script.landing!.shift()) } : {}),
    now: () => now,
    schedule: (run, ms) => {
      timers.push({ run, ms })
      return () => {}
    },
    cliTrades: trades,
    ...(script.budget ? { bridgeBudget: script.budget } : {}),
  })
  const tick = async () => {
    const next = timers.shift()
    if (!next) return undefined
    now += next.ms
    await next.run()
    return next.ms
  }
  return { ops, journal, ran, calls, tick, timers, submittedBeforeRun, landingReads, at: () => now }
}

const FACTS = { to: "ETH", fromName: "bot-1", toName: "bot-1-h" }
const ARGV = ["swap", "SOL", "ETH", "--amount", "0.5", "--wallet", TEE_SOL.address, "--to", TEE_HOOD.address, "--client-trade-id", "op-b", "--yes", "--json"]
const teeBridge = (): Card =>
  ({
    cardId: "card-b",
    opId: "op-b",
    kind: "bridge",
    tool: "candle_bridge",
    agent: "momentum",
    mode: "live",
    route: "cli",
    wallet: TEE_SOL.address,
    chain: "solana",
    expiresAt: new Date(T0 + 60_000).toISOString(),
    params: { argv: ARGV, identity: "agent", agent: "momentum", json: true, bridge: FACTS },
  }) as unknown as Card
const RECEIPT = { success: true, kind: "swap", clientTradeId: "op-b", bridge: { from: "SOL", to: "ETH", destination: TEE_HOOD.address, depositHash: "5DepositSig" }, quote: { venue: "relay", candleFee: "none", relayFees: "about $0.048 as Relay reports it" } }
const status = (phase: string, extra: Record<string, unknown> = {}) => ({ kind: "swap", job: { status: "submitted" }, bridgeStatus: { phase, ...extra } })

describe("a TEE bridge's run, followed", () => {
  test("written down before it's sent, sent once, then read every 10 s by its id until it arrives, with what arrived", async () => {
    const s = await opsSetup({ runs: [{ json: RECEIPT }], statuses: [status("filling", { open: "open" }), status("filled", { settledOutRaw: "313692000000000" })] })
    const op = await s.ops.execute(teeBridge())
    expect(s.submittedBeforeRun).toEqual([true])
    expect(op.state).toBe("pending")
    expect(s.timers[0]!.ms).toBe(10_000)
    await s.tick()
    expect(op.state).toBe("pending")
    await s.tick()
    expect(op.state).toBe("succeeded")
    expect((op.result as { received?: string }).received).toBe("0.000313692 ETH")
    // The receipt's quote is kept beside where it stands.
    expect((op.result as { quote?: unknown }).quote).toEqual(RECEIPT.quote)
    expect(s.ran.filter((a) => a[1] !== "status")).toEqual([ARGV])
    expect(s.ran.filter((a) => a[1] === "status")).toEqual([
      ["swap", "status", "op-b", "--kind", "swap", "--json"],
      ["swap", "status", "op-b", "--kind", "swap", "--json"],
    ])
    expect(s.timers).toEqual([])
  })

  test("a refund is said as one, to the wallet it came from", async () => {
    const s = await opsSetup({ runs: [{ json: RECEIPT }], statuses: [{ kind: "swap", job: { settlement: { state: "failed", legs: [{ status: "confirmed" }] } } }] })
    const op = await s.ops.execute(teeBridge())
    await s.tick()
    expect(op.state).toBe("failed")
    expect(op.error?.message).toContain("Relay refunds it to bot-1")
  })

  test("with no room in the key's budget, the read waits for its next turn; nothing is sent again", async () => {
    let room = false
    const s = await opsSetup({ runs: [{ json: RECEIPT }], statuses: [status("filled", { settledOutRaw: "1000000000000000" })], budget: () => room })
    const op = await s.ops.execute(teeBridge())
    await s.tick()
    expect(s.ran.filter((a) => a[1] === "status")).toEqual([])
    expect(op.state).toBe("pending")
    room = true
    await s.tick()
    expect(op.state).toBe("succeeded")
    expect(s.ran.filter((a) => a[1] !== "status")).toHaveLength(1)
  })

  test("read every minute after ten; past its two hours with no end, it says where to look and is followed no further", async () => {
    const statuses = Array.from({ length: 200 }, () => status("filling", { open: "open" }))
    const s = await opsSetup({ runs: [{ json: RECEIPT }], statuses })
    const op = await s.ops.execute(teeBridge())
    const gaps: number[] = []
    for (let ms = await s.tick(); ms !== undefined; ms = await s.tick()) gaps.push(ms)
    expect(gaps.filter((g) => g === 10_000).length).toBe(60)
    expect(gaps.slice(60).every((g) => g === 60_000)).toBe(true)
    expect(op.state).toBe("unknown")
    expect(op.error?.code).toBe("BRIDGE_PAST_TWO_HOURS")
    expect(s.timers).toEqual([])
  })

  test("uncertain is said, with where to look, and isn't read again", async () => {
    const s = await opsSetup({ runs: [{ json: RECEIPT }], statuses: [status("uncertain")] })
    const op = await s.ops.execute(teeBridge())
    await s.tick()
    expect(op).toMatchObject({ state: "unknown", error: { code: "BRIDGE_UNCERTAIN" } })
    expect(s.timers).toEqual([])
  })

  const HOOD_ARGV = ["swap", "ETH", "SOL", "--amount", "0.01", "--wallet", TEE_HOOD.address, "--to", TEE_SOL.address, "--client-trade-id", "op-b", "--yes", "--json"]
  const hoodBridge = (): Card => ({ ...teeBridge(), wallet: TEE_HOOD.address, chain: "hood", params: { argv: HOOD_ARGV, identity: "agent", agent: "momentum", json: true, bridge: { to: "SOL", fromName: "bot-1-h", toName: "bot-1" } } }) as unknown as Card
  const hoodSell = (at: number): Card =>
    ({ cardId: "card-t", opId: "op-t", kind: "trade", tool: "candle_trade", agent: "momentum", mode: "live", route: "cli", wallet: TEE_HOOD.address, chain: "hood", side: "sell", expiresAt: new Date(at + 60_000).toISOString(), params: { argv: ["swap", "0x00000000000000000000000000000000000a0b01", "ETH", "--percent", "100", "--wallet", TEE_HOOD.address, "--client-trade-id", "op-t", "--yes", "--json"], identity: "agent", agent: "momentum", json: true } }) as unknown as Card
  const SOLD = { json: { success: true, status: "executed", signature: "0x01" } }

  test("a Hood-origin bridge Candle calls uncertain lets its Hood TEE wallet go: a sell there is sent", async () => {
    const s = await opsSetup({ runs: [{ json: RECEIPT }, SOLD], statuses: [status("uncertain")] })
    const b = await s.ops.execute(hoodBridge())
    await s.tick()
    expect(b).toMatchObject({ state: "unknown", error: { code: "BRIDGE_UNCERTAIN" } })
    const t = await s.ops.execute(hoodSell(s.at()))
    expect(t.waitingFor).toBeUndefined()
    expect(t.state).toBe("succeeded")
  })

  test("a Hood-origin bridge whose deposit landed lets its wallet go while Relay fills: the sell waiting behind it is sent", async () => {
    const s = await opsSetup({ runs: [{ json: RECEIPT }, SOLD], statuses: [status("filling", { open: "open" }), status("filled", { settledOutRaw: "1000000000" })] })
    const b = await s.ops.execute(hoodBridge())
    const t = await s.ops.execute(hoodSell(s.at()))
    expect(t.waitingFor).toBe("op-b")
    await s.tick()
    await Bun.sleep(25)
    expect(b.state).toBe("pending")
    expect(t.state).toBe("succeeded")
    expect(s.ran.filter((a) => a[1] !== "status")).toHaveLength(2)
  })

  test("past its two hours, a read that couldn't be made doesn't end the follow: the next read that answers does", async () => {
    let room = false
    const s = await opsSetup({ runs: [{ json: RECEIPT }], statuses: [status("filled", { settledOutRaw: "1000000000000000" })], budget: () => room })
    const op = await s.ops.execute(teeBridge())
    for (let i = 0; i < 400 && s.at() - T0 < 2 * 60 * 60_000 + 60_000 && (await s.tick()) !== undefined; i++);
    expect(op.state).toBe("pending")
    expect(s.timers).toHaveLength(1)
    room = true
    await s.tick()
    expect(op).toMatchObject({ state: "succeeded", result: { received: "0.001 ETH" } })
  })

  test("a restart reads an open bridge back by its id, and never runs it again", async () => {
    const s = await opsSetup({ statuses: [status("filled", { settledOutRaw: "1000000000000000" })] })
    await s.journal.append({ type: "operation.submitting", mode: "live", agent: "momentum", opId: "op-b", cardId: "card-b", kind: "bridge", tool: "candle_bridge", params: teeBridge().params, chain: "solana", cardExpiresAt: T0 + 60_000, route: "cli", wallet: TEE_SOL.address })
    await s.journal.append({ type: "operation.pending", mode: "live", agent: "momentum", opId: "op-b", cardId: "card-b", result: RECEIPT })
    expect(await s.ops.rebuild(s.journal.rows())).toEqual(["op-b"])
    s.ops.readBack()
    await s.tick()
    expect(s.ops.get("op-b")).toMatchObject({ state: "succeeded", result: { received: "0.001 ETH" } })
    expect(s.ran).toEqual([["swap", "status", "op-b", "--kind", "swap", "--json"]])
  })
})

describe("an embedded bridge's run", () => {
  const embeddedBridge = (): Card =>
    ({
      cardId: "card-e",
      opId: "op-e",
      kind: "bridge",
      tool: "candle_bridge",
      agent: "momentum",
      mode: "live",
      wallet: EMBEDDED,
      chain: "solana",
      expiresAt: new Date(T0 + 60_000).toISOString(),
      params: { from: "SOL", to: "ETH", amount: "0.5", clientSwapId: "op-e", bridge: { to: "ETH", fromName: "embedded", toName: "embedded on Hood" } },
    }) as unknown as Card

  /** Candle's 200 for a bridge between the embedded wallets: no status of its own, where it stands in `settlement`. */
  const answer = (state: string, opts: { landed?: boolean; out?: string } = {}): ToolOutcome => ({
    kind: "ok",
    result: {
      clientSwapId: "op-e",
      success: true,
      payload: {
        hashes: ["5DepositSig"],
        expectedOutRaw: "25000000000000000",
        outDecimals: 18,
        statusChecks: ["https://relay.example.invalid/intents/status?requestId=0xabc"],
        settlement: { state, legs: [{ chain: "solana", hash: "5DepositSig", status: opts.landed === false ? "failed" : "confirmed" }], in: { asset: "SOL", raw: "500000000" }, expectedOutRaw: "25000000000000000", ...(opts.out ? { settledOutRaw: opts.out } : {}) },
        receiptStored: true,
      },
    },
  })
  const BEFORE = 1_000_000_000_000_000n

  test("Candle's candle_swap, under the card's id, without the card's own words; settled is arrived, with what arrived", async () => {
    const s = await opsSetup({ mcp: [answer("settled", { out: "24900000000000000" })], landing: [BEFORE] })
    const op = await s.ops.execute(embeddedBridge())
    expect(s.calls).toEqual([{ tool: "candle_swap", args: { from: "SOL", to: "ETH", amount: "0.5", clientSwapId: "op-e" } }])
    expect(op.state).toBe("succeeded")
    expect((op.result as { received?: string }).received).toBe("0.0249 ETH")
  })

  test("failed after the deposit landed is a refund to the embedded wallet; failed before it, nothing was bridged; never arrived", async () => {
    const refunded = await opsSetup({ mcp: [answer("failed")], landing: [BEFORE] })
    const op = await refunded.ops.execute(embeddedBridge())
    expect(op).toMatchObject({ state: "failed", error: { code: "BRIDGE_FAILED", message: expect.stringContaining("Relay refunds it to embedded") } })
    const none = await opsSetup({ mcp: [answer("failed", { landed: false })], landing: [BEFORE] })
    expect(await none.ops.execute(embeddedBridge())).toMatchObject({ state: "failed", error: { message: expect.stringContaining("nothing was bridged") } })
  })

  test("pending is on its way, followed through the key's budget by the landing wallet's balance against the one read before it went", async () => {
    const asked: (number | undefined)[] = []
    const s = await opsSetup({ mcp: [answer("pending")], landing: [BEFORE, BEFORE, BEFORE + 24_800_000_000_000_000n], budget: (_agent, requests) => (asked.push(requests), true) })
    const op = await s.ops.execute(embeddedBridge())
    // The balance before is read before anything is sent, and written down with the send.
    expect(s.landingReads[0]).toBe(0)
    expect(s.journal.rows().find((r) => r.type === "operation.submitting")).toMatchObject({ landingBefore: String(BEFORE) })
    expect(op.state).toBe("pending")
    expect(s.timers[0]!.ms).toBe(10_000)
    await s.tick()
    expect(op.state).toBe("pending")
    await s.tick()
    expect(op.state).toBe("succeeded")
    expect(s.calls).toHaveLength(1)
    expect(asked).toEqual([2, 2])
    expect(s.timers).toEqual([])
  })

  test("pending with no balance read before it went says where to look, and isn't followed", async () => {
    const s = await opsSetup({ mcp: [answer("pending")], landing: [undefined] })
    const op = await s.ops.execute(embeddedBridge())
    expect(op).toMatchObject({ state: "unknown", error: { code: "BRIDGE_UNFOLLOWED", message: expect.stringContaining("embedded on Hood") } })
    expect(s.timers).toEqual([])
  })

  test("uncertain says where to look, and isn't followed", async () => {
    const s = await opsSetup({ mcp: [answer("uncertain")], landing: [BEFORE] })
    expect(await s.ops.execute(embeddedBridge())).toMatchObject({ state: "unknown", error: { code: "BRIDGE_UNCERTAIN", message: expect.stringContaining("embedded on Hood") } })
    expect(s.timers).toEqual([])
  })

  test("with no answer, it's replayed under its id past its card's 60 s, until Candle's answer says where it stands", async () => {
    const running: ToolOutcome = { kind: "error", code: "IDEMPOTENCY_CONFLICT", retryable: true, body: { clientSwapId: "op-e", success: false, error: { code: "IDEMPOTENCY_CONFLICT", message: "still running", retryable: true } } }
    const s = await opsSetup({ mcp: [{ kind: "lost", reason: "timeout" }, ...Array.from({ length: 15 }, () => running), answer("settled", { out: "24900000000000000" })], landing: [BEFORE] })
    const op = await s.ops.execute(embeddedBridge())
    expect(op.state).toBe("unknown")
    for (let i = 0; i < 40 && op.state === "unknown" && (await s.tick()) !== undefined; i++);
    expect(s.at() - T0).toBeGreaterThan(60_000)
    expect(op.state).toBe("succeeded")
    expect(new Set(s.calls.map((c) => c.args.clientSwapId))).toEqual(new Set(["op-e"]))
  })

  test("a restart follows a pending one by its balance, and never sends it again", async () => {
    const s = await opsSetup({ landing: [BEFORE + 25_000_000_000_000_000n] })
    const card = embeddedBridge()
    await s.journal.append({ type: "operation.submitting", mode: "live", agent: "momentum", opId: "op-e", cardId: "card-e", kind: "bridge", tool: "candle_bridge", params: card.params, chain: "solana", cardExpiresAt: T0 + 60_000, landingBefore: String(BEFORE) })
    await s.journal.append({ type: "operation.pending", mode: "live", agent: "momentum", opId: "op-e", cardId: "card-e", result: (answer("pending") as { result: unknown }).result })
    expect(await s.ops.rebuild(s.journal.rows())).toEqual(["op-e"])
    s.ops.readBack()
    await s.tick()
    expect(s.ops.get("op-e")!.state).toBe("succeeded")
    expect(s.calls).toEqual([])
  })
})

describe("the kill switch", () => {
  test("it withdraws a waiting bridge card, keeps none open, and lists one in flight, which it can't stop", async () => {
    const s = await setup()
    const waiting = await s.propose({ from: "SOL", to: "ETH", amount: "0.5", wallet: "bot-1" })
    const dir = await mkdtemp(join(tmpdir(), "chrn-bridge-kill-"))
    dirs.push(dir)
    const inFlight = { opId: "op-sent", cardId: "card-sent", agent: "momentum", kind: "bridge" as const, tool: "candle_bridge", mode: "live" as const, params: {}, state: "pending" as const, startedAt: T0, cardExpiresAt: T0 + 60_000, route: "cli" as const }
    const kill = await KillSwitch.open({
      journal: s.journal,
      mode: () => "live",
      statePath: join(dir, "kill.json"),
      now: () => T0,
      agents: () => ["momentum"],
      cards: s.book,
      operations: { list: () => [inFlight] },
      engine: { cancelAll: async () => [] },
      spend: new DaySpend(),
      limitsFor: () => ({ perDayUsd: 50 }),
      walletsOf: () => [EMBEDDED],
      portfolio: () => undefined,
      prices: { usd: () => undefined },
      keyPrefix: () => "momeAb3d",
      publish: () => {},
      onChange: () => {},
    })
    const { report } = await kill.kill("v1")
    expect(s.book.get(waiting.cardId)!.state).toBe("withdrawn")
    expect(report.stopped.cards.map((c) => c.cardId)).toContain(waiting.cardId)
    expect(report.stillOpen).toEqual([])
    expect(report.inFlight).toEqual([expect.objectContaining({ opId: "op-sent", state: "pending" })])
  })

  test("a bridge card approved while the kill switch is on is refused, and nothing is sent", async () => {
    const s = await setup()
    const card = await s.propose({ from: "SOL", to: "ETH", amount: "0.5", wallet: "bot-1" })
    s.setPaused(true)
    expect((await refusal(s.book.approve("v1", card.cardId, card.cardHash, "enter"))).code).toBe("PAUSED")
  })
})

describe("the records", () => {
  test("Activity says it arrived, with what arrived; a refund is said as one; nothing counts it against the day's spend", async () => {
    const s = await setup()
    const card = await s.propose({ from: "SOL", to: "ETH", amount: "0.5", wallet: "bot-1" })
    await s.book.approve("v1", card.cardId, card.cardHash, "enter")
    // A move between the key's own wallets is no spend: today's figure is as it was.
    expect(s.spend.spent("momentum", T0)).toBe(0)
    const log = new TradeLog({ symbolOf: () => undefined })
    for (const row of s.journal.rows()) log.add(row)
    log.add({ seq: 90, at: new Date(T0).toISOString(), type: "operation.pending", mode: "live", agent: "momentum", opId: card.opId, cardId: card.cardId } as never)
    log.add({ seq: 91, at: new Date(T0).toISOString(), type: "operation.succeeded", mode: "live", agent: "momentum", opId: card.opId, cardId: card.cardId, result: { received: "0.000313692 ETH" } } as never)
    expect(log.activity().at(-1)!.text).toBe("arrived BRIDGE 0.5 SOL → ETH from bot-1 · 0.000313692 ETH")
    const refunded = new TradeLog({ symbolOf: () => undefined })
    for (const row of s.journal.rows()) refunded.add(row)
    refunded.add({ seq: 92, at: new Date(T0).toISOString(), type: "operation.failed", mode: "live", agent: "momentum", opId: card.opId, cardId: card.cardId, error: { code: "BRIDGE_FAILED", message: "The deposit landed and Relay didn't fill it: Relay refunds it to bot-1. Check that wallet's balance." } } as never)
    expect(refunded.activity().at(-1)!.text).toContain("Relay refunds it to bot-1")
  })

  test("a bridge no longer followed says why and where to look in Activity, never that it's being read back", async () => {
    const s = await setup()
    const card = await s.propose({ from: "SOL", to: "ETH", amount: "0.5", wallet: "bot-1" })
    await s.book.approve("v1", card.cardId, card.cardHash, "enter")
    const log = new TradeLog({ symbolOf: () => undefined })
    for (const row of s.journal.rows()) log.add(row)
    const message = bridgeMapped({ phase: "uncertain" }, { result: {}, facts: { to: "ETH", fromName: "bot-1", toName: "bot-1-h" }, sent: true }).error!.message
    log.add({ seq: 93, at: new Date(T0).toISOString(), type: "operation.unknown", mode: "live", agent: "momentum", opId: card.opId, cardId: card.cardId, reason: "uncertain", error: { code: "BRIDGE_UNCERTAIN", message } } as never)
    const text = log.activity().at(-1)!.text
    expect(text).not.toContain("reading it back")
    expect(text).toContain("BRIDGE 0.5 SOL → ETH")
    expect(text).toContain("Check the balance of bot-1-h")
    // Any other operation with no answer yet is still being read back.
    log.add({ seq: 94, at: new Date(T0).toISOString(), type: "operation.unknown", mode: "live", agent: "momentum", opId: card.opId, cardId: card.cardId, reason: "core_restarted" } as never)
    expect(log.activity().at(-1)!.text).toContain("reading it back")
  })
})

describe("an embedded bridge in a core, against Candle's answer as Candle sends it", () => {
  const cores: TestCore[] = []
  afterEach(async () => {
    for (const c of cores.splice(0)) await c.close()
  })

  async function bridged(script: Record<string, unknown>) {
    const c = await startTestCore({}, { candle: { momentum: { ethUsd: 3000, evmWei: "1000000000000000", ...script }, swing: { ethUsd: 3000 } } })
    cores.push(c)
    const view = await c.view("candle-harness")
    const proposed = await view.request("cards.propose", { tool: "candle_bridge", args: { from: "SOL", to: "ETH", amount: "0.1", wallet: "embedded" }, typed: true })
    expect(proposed.error).toBeUndefined()
    const card = proposed.result as { cardId: string; cardHash: string; opId: string }
    await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })
    return { c, opId: card.opId }
  }

  test("settled: arrived, with what Candle measured arriving", async () => {
    const { c, opId } = await bridged({})
    await until(() => c.core.operations.get(opId)?.state === "succeeded")
    expect((c.core.operations.get(opId)!.result as { received?: string }).received).toBe("0.005 ETH")
  })

  test("pending: on its way, followed by the embedded EVM wallet's balance read before it went, never arrived on the deposit alone", async () => {
    const { c, opId } = await bridged({ bridgeSettlement: "pending" })
    await until(() => c.core.operations.get(opId)?.state === "pending")
    expect(c.core.operations.get(opId)!.landingBefore).toBe("1000000000000000")
    expect(c.core.operations.openBridges().map((o) => o.opId)).toEqual([opId])
  })

  test("failed after the deposit: a refund to the embedded wallet, not arrived", async () => {
    const { c, opId } = await bridged({ bridgeSettlement: "failed" })
    await until(() => c.core.operations.get(opId)?.state === "failed")
    expect(c.core.operations.get(opId)!.error?.message).toContain("Relay refunds it to embedded")
  })
})

test("a landing wallet's token row Candle sends without its amount or decimals is a balance not known, never 0", () => {
  const usdg = BASE_ASSETS.USDG.address!
  const at = (row: Record<string, unknown>) => ({ hood: { embedded: [{ address: EMBEDDED_EVM, chain: "hood", wei: "0", tokens: [{ mint: usdg, ...row }] }], tee: [] } })
  // Read as 0, a row that reads whole later would look like the bridge's arrival.
  expect(landingBalance(at({ amountRaw: null, decimals: 6 }), EMBEDDED_EVM, "USDG")).toBeUndefined()
  expect(landingBalance(at({ amountRaw: "5000000" }), EMBEDDED_EVM, "USDG")).toBeUndefined()
  expect(landingBalance(at({ amountRaw: "5000000", decimals: 6 }), EMBEDDED_EVM, "USDG")).toBe(5_000_000n)
  expect(landingBalance({ hood: { embedded: [{ address: EMBEDDED_EVM, chain: "hood", wei: "0", tokens: [] }], tee: [] } }, EMBEDDED_EVM, "USDG")).toBe(0n)
})

test("what arrived is said in six figures, never Candle's eighteen", () => {
  expect(receivedWords("796504459160177", "ETH")).toBe("0.000796504 ETH")
  expect(receivedWords("70800000000000000", "ETH")).toBe("0.0708 ETH")
  expect(receivedWords("12019241", "SOL")).toBe("0.0120192 SOL")
  expect(receivedWords("1500000000", "SOL")).toBe("1.5 SOL")
})
