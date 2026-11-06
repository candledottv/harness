// The contract with Candle's real MCP server, as recorded on a real account (server 0.10.22 through
// `candle mcp`, CLI 0.11.41), scrubbed into test/fixtures/candle-recorded/.
// Two checks: the core reads the real answers the way it reads the fake's, and the fake answers with
// every field the core relies on, in the place the real server puts it.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fixture from "../../test/fixtures/candle-tools.json"
import { parseExecutionStatus } from "./agent-status"
import { joinTee, parseProfileWallets } from "./agent-wallets"
import { CandleMcpPool, candleConfigDir, type ToolOutcome } from "./candle-mcp"
import { resultWasPaper } from "./classify"
import { holdingFrom } from "./core-main"
import { outcomeOf } from "./execute"
import { Markets } from "./markets"
import { PriceBook } from "./prices"
import { readTrade } from "./reconcile"

const SOL = "So11111111111111111111111111111111111111112"
// As in test/fake-candle-mcp.ts and scripts/scrub-recordings.ts (importing the fake would start it).
const FAKE_WALLET = "WalletFake111111111111111111111111111111111"
const FAKE_MINTS = { MOON: "MoonFake11111111111111111111111111111111111", PEPE: "PepeFake11111111111111111111111111111111111" }
const dir = join(import.meta.dir, "../../test/fixtures/candle-recorded")
interface Recording {
  tool: string
  args: Record<string, unknown>
  ms: number
  outcome: ToolOutcome
}
const recorded = (name: string): Recording => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"))
const stub = (outcome: ToolOutcome) => ({ call: async () => outcome })

/** The value at a dotted path, or undefined; numeric parts index arrays. */
function at(value: unknown, path: string): unknown {
  let here = value
  for (const part of path.split(".")) {
    if (here === null || typeof here !== "object") return undefined
    here = (here as Record<string, unknown>)[part]
  }
  return here
}

describe("the core reads the real answers", () => {
  test("execution status: the embedded-wallet permission, the plan fee and the key's tx limit", () => {
    const a = parseExecutionStatus((recorded("cli-agent-a-candle_execution_status").outcome as { result: unknown }).result, 0)!
    expect(a).toMatchObject({ wallets: { solana: FAKE_WALLET }, embeddedWallet: "allowed", feeBps: 25, keyLimit: { usd: 100, reset: "daily" } })
    const denied = parseExecutionStatus((recorded("cli-agent-denied-candle_execution_status").outcome as { result: unknown }).result, 0)!
    expect(denied.embeddedWallet).toBe("denied")
    expect(denied.keyLimit).toBeUndefined() // `txLimit: null`: no Candle cap on this key
    // A denied key still reports the account's wallets: the permission is the only sign.
    expect(denied.wallets.solana).toBe(FAKE_WALLET)
  })

  test("a paper buy's answer is a success, marked paper", () => {
    const { outcome } = recorded("cli-agent-a-candle_trade-paper-buy")
    expect(outcome.kind).toBe("ok")
    expect(resultWasPaper((outcome as { result: unknown }).result)).toBe(true)
    expect(outcomeOf("trade", outcome)).toMatchObject({ state: "succeeded", paper: true })
  })

  test("a paper trade is never found by its id: paper writes no ledger row (docs.candle.tv/developers/agent-trading, Paper mode)", async () => {
    const paper = recorded("cli-agent-a-candle_get_operation-paper")
    expect(paper.args.clientId).toBe(recorded("cli-agent-a-candle_trade-paper-buy").args.clientTradeId)
    expect(await readTrade(stub(paper.outcome), String(paper.args.clientId))).toEqual({ found: false, detail: "JOB_NOT_FOUND" })
    expect(at(paper.outcome, "body.outcome")).toBe("unknown")
  })

  test("a token resolves from the real market shape", async () => {
    const markets = new Markets({ pool: { for: () => stub(recorded("cli-agent-a-candle_resolve_token").outcome) } })
    expect(await markets.resolve("a", SOL)).toEqual({
      ok: true,
      market: { chain: "solana", mint: SOL, symbol: "SOL", candleLaunched: false, quoteMint: SOL, quoteDecimals: 9 },
    })
  })

  test("prices come from the portfolio's map, Hood's native price included", async () => {
    const book = new PriceBook({ read: async () => recorded("cli-agent-a-candle_get_portfolio").outcome, now: () => 0 })
    await book.refresh()
    expect(book.usd(SOL)).toBe(150)
    expect(book.usd("hood:native")).toBe(3000)
  })

  test("holdings: an empty token list is none, not unreadable", () => {
    const result = (recorded("cli-agent-a-candle_get_portfolio").outcome as { result: unknown }).result
    expect(holdingFrom(result, FAKE_WALLET, FAKE_MINTS.MOON)).toBe("none")
  })

  test("the portfolio never shows paper positions: a paper buy leaves it as it was", () => {
    const before = recorded("cli-agent-a-candle_get_portfolio").outcome as { result: Record<string, unknown> }
    const after = recorded("cli-agent-a-candle_get_portfolio-after-paper").outcome as { result: Record<string, unknown> }
    expect(after.result.embedded).toEqual(before.result.embedded)
  })

  test("the tool fixture holds every tool each key's recorded handshake listed, at server 0.10.25 and 0.10.22", () => {
    const names = fixture.tools.map((t) => t.name).sort()
    for (const label of ["agent-a", "agent-b"]) {
      const handshake = JSON.parse(readFileSync(join(dir, "cli-0.13.5", `cli-${label}-handshake.json`), "utf8")) as { status: { version: string }; toolNames: string[] }
      expect(handshake.status.version).toBe("0.10.25")
      expect(handshake.toolNames.filter((n) => !names.includes(n))).toEqual([])
    }
    for (const label of ["agent-a", "agent-b", "agent-denied"]) {
      const handshake = JSON.parse(readFileSync(join(dir, `cli-${label}-handshake.json`), "utf8")) as { status: { version: string }; toolNames: string[] }
      expect(handshake.status.version).toBe("0.10.22")
      expect(handshake.toolNames.filter((n) => !names.includes(n))).toEqual([])
    }
  })
})

// The fields the core reads, per tool, where the real server puts them.
const CONTRACT: { recording: string; tool: string; args: Record<string, unknown>; paths: string[] }[] = [
  {
    recording: "cli-agent-a-candle_get_wallets",
    tool: "candle_get_wallets",
    args: {},
    paths: ["result.success", "result.account", "result.wallets.solana.address", "result.wallets.evm.address", "result.embeddedWalletPermission"],
  },
  {
    recording: "cli-agent-a-candle_execution_status",
    tool: "candle_execution_status",
    args: {},
    paths: ["result.success", "result.ready", "result.wallets.embeddedWalletPermission", "result.tier.feeBps", "result.limits.txLimit.usdMicros", "result.limits.txLimit.reset"],
  },
  {
    recording: "cli-agent-a-candle_get_portfolio",
    tool: "candle_get_portfolio",
    args: {},
    paths: ["result.success", "result.embedded.0.address", "result.embedded.0.lamports", "result.embedded.0.tokens", "result.tee", "result.hood.embedded", "result.prices", "result.complete", "result.walletsComplete"],
  },
  {
    recording: "cli-agent-a-candle_token_forensics",
    tool: "candle_token_forensics",
    args: { chain: "solana", mint: FAKE_MINTS.PEPE },
    paths: ["result.success", "result.forensics.mint", "result.forensics.safety.summary", "result.forensics.safety.flags.mintAuthority.status", "result.forensics.safety.flags.sellability.status"],
  },
  ...["candle_resolve_token", "candle_get_market"].map((tool) => ({
    recording: `cli-agent-a-${tool}`,
    tool,
    args: tool === "candle_get_market" ? { chain: "solana", mint: FAKE_MINTS.PEPE } : { mint: FAKE_MINTS.PEPE },
    paths: ["result.success", "result.market.chain", "result.market.mint", "result.market.lifecycle", "result.market.quoteMint", "result.market.quoteDecimals", "result.market.candleLaunched", "result.market.trade.routable", "result.market.metadata.symbol", "result.market.priceUsd"],
  })),
  {
    recording: "cli-agent-a-candle_get_operation-not-found",
    tool: "candle_get_operation",
    args: { clientId: "00000000-0000-4000-8000-00000000abcd", kind: "trade" },
    paths: ["code", "body.success", "body.error.code", "body.error.retryable", "body.outcome", "body.next"],
  },
  {
    recording: "cli-agent-a-candle_trade-paper-buy",
    tool: "candle_trade",
    args: { mint: FAKE_MINTS.MOON, side: "buy", amount: "0.01", paper: true, clientTradeId: "00000000-0000-4000-8000-00000000beef" },
    paths: ["result.clientTradeId", "result.resolved.amountDecimal", "result.api.success", "result.api.paper", "result.api.clientTradeId", "result.api.mint", "result.api.side", "result.api.feeBps", "result.api.note"],
  },
]

describe("the fake answers in the real shapes", () => {
  let binDir: string
  let pool: CandleMcpPool
  let stateDir: string
  beforeAll(async () => {
    binDir = mkdtempSync(join(tmpdir(), "chrn-fakebin-"))
    await $`bun build --compile ${join(import.meta.dir, "../../test/fake-candle-mcp.ts")} --outfile ${join(binDir, "candle")}`.quiet()
  })
  afterAll(() => rmSync(binDir, { recursive: true, force: true }))
  afterEach(async () => {
    await pool?.stop()
    rmSync(stateDir, { recursive: true, force: true })
  })

  test("every field the core reads is where the real server puts it", async () => {
    stateDir = mkdtempSync(join(tmpdir(), "chrn-recorded-"))
    pool = new CandleMcpPool({
      route: "cli",
      path: join(binDir, "candle"),
      stateDir,
      parentEnv: process.env,
      agents: [{ name: "a", apiKey: `cndl_live_${"a".repeat(43)}` }],
      child: { backoffMs: [100] },
    })
    await pool.start()
    const missing: string[] = []
    for (const { recording, tool, args, paths } of CONTRACT) {
      const real = recorded(recording).outcome
      const fake = await pool.for("a").call(tool, args)
      expect(fake.kind).toBe(real.kind)
      for (const path of paths) {
        if (at(real, path) === undefined) missing.push(`real ${recording}: ${path}`)
        if (at(fake, path) === undefined) missing.push(`fake ${tool}: ${path}`)
      }
      // The fake invents no top-level field the real server doesn't send.
      const top = (o: ToolOutcome) => Object.keys((o.kind === "ok" ? o.result : o.body) as object)
      for (const key of top(fake)) if (!top(real).includes(key)) missing.push(`fake ${tool} adds ${key}`)
    }
    expect(missing).toEqual([])
  })

  test("a live sell of an external token by amount is refused as Candle refused it live; by percent it runs", async () => {
    stateDir = mkdtempSync(join(tmpdir(), "chrn-recorded-"))
    pool = new CandleMcpPool({
      route: "cli",
      path: join(binDir, "candle"),
      stateDir,
      parentEnv: process.env,
      agents: [{ name: "a", apiKey: `cndl_live_${"a".repeat(43)}` }],
      child: { backoffMs: [100] },
    })
    await pool.start()
    const byAmount = await pool.for("a").call("candle_trade", { mint: FAKE_MINTS.PEPE, side: "sell", amount: "10", clientTradeId: "t-amount" })
    expect(byAmount).toMatchObject({ kind: "error", code: "MCP_VALIDATION" })
    expect(outcomeOf("trade", byAmount).state).toBe("refused")
    const byPercent = await pool.for("a").call("candle_trade", { mint: FAKE_MINTS.MOON, side: "sell", percent: 50, clientTradeId: "t-percent" })
    expect(outcomeOf("trade", byPercent).state).toBe("succeeded")
  })
})

// The TEE wallet rebound to agent-a's key, recorded through `candle mcp` on
// 2026-10-27 with agent-a's and agent-b's keys, scrubbed into candle-recorded/tee/.
const recordedTee = (name: string): Recording => JSON.parse(readFileSync(join(dir, "tee", `${name}.json`), "utf8"))
const clicmd = (name: string): { command: string; exit: number; stdout: Record<string, unknown> } =>
  JSON.parse(readFileSync(join(dir, "tee", `clicmd-${name}.json`), "utf8"))

describe("the recorded shapes: TEE wallets", () => {
  test("the profile read lists the TEE wallet bound to agent-a's key, and none for agent-b's, under walletScope selected", () => {
    const a = recordedTee("cli-agent-a-candle_get_profile_wallets").outcome as { kind: "ok"; result: { keyPrefix: string; walletScope: string; wallets: { address: string; linkedWalletId: string; spendCapable: boolean }[] } }
    const b = recordedTee("cli-agent-b-candle_get_profile_wallets").outcome as { kind: "ok"; result: { walletScope: string; wallets: unknown[] } }
    expect(a.result.walletScope).toBe("selected")
    expect(a.result.wallets).toHaveLength(1)
    expect(a.result.wallets[0]!.spendCapable).toBe(true)
    expect(b.result.walletScope).toBe("selected")
    expect(b.result.wallets).toEqual([])
    // The same wallet in the account-wide portfolio, joined by linkedWalletId (the payable wallets' join).
    const portfolio = recordedTee("cli-agent-a-candle_get_portfolio").outcome as { kind: "ok"; result: { tee: { id: string; address: string; active: boolean }[] } }
    const tee = portfolio.result.tee.find((t) => t.id === a.result.wallets[0]!.linkedWalletId)
    expect(tee?.address).toBe(a.result.wallets[0]!.address)
    expect(tee?.active).toBe(true)
    // agent-b's portfolio lists it too: the portfolio is the account's, not the key's.
    const other = recordedTee("cli-agent-b-candle_get_portfolio").outcome as { kind: "ok"; result: { tee: { id: string }[] } }
    expect(other.result.tee.map((t) => t.id)).toEqual([tee!.id])
  })

  test("the CLI agrees with the MCP read: tee status answers for agent-a's key and refuses agent-b's", () => {
    const bound = clicmd("tee-status-bound")
    expect(bound.exit).toBe(0)
    expect(at(bound.stdout, "server.remoteAuthority")).toBe("verified-active")
    expect(at(bound.stdout, "server.boundKeyPrefix")).toBe("FakeKey1")
    const other = clicmd("tee-status-other-key")
    expect(other.exit).toBe(1)
    expect(other.stdout.code).toBe("TEE_WALLET_NOT_ON_KEY")
    expect(clicmd("keys-wallets-bound").stdout.wallets).toHaveLength(1)
    expect(clicmd("keys-wallets-none").stdout.wallets).toEqual([])
  })

  test("a quote declined at the prompt is a cancelled result naming its kind; TEE base swaps are on", () => {
    const trade = clicmd("swap-trade-cancelled").stdout
    const swap = clicmd("swap-swap-cancelled").stdout
    expect(trade).toMatchObject({ success: true, status: "cancelled", kind: "trade" })
    expect(swap).toMatchObject({ success: true, status: "cancelled", kind: "swap" })
    for (const path of ["quote.wallet", "quote.venue", "quote.fee.bps", "quote.minOutRaw"]) {
      expect(at(trade, path)).toBeDefined()
      expect(at(swap, path)).toBeDefined()
    }
  })

  test("swap status: a built job on its own rail, JOB_NOT_FOUND on the other and for an unknown id", () => {
    expect(at(clicmd("swap-status-trade-built").stdout, "job.status")).toBe("built")
    expect(at(clicmd("swap-status-swap-built").stdout, "job.status")).toBe("built")
    // A built swap job carries no settlement yet: only status, id, kind and a null signature.
    expect(Object.keys(at(clicmd("swap-status-swap-built").stdout, "job") as object).sort()).toEqual(["clientTradeId", "kind", "signature", "status"])
    for (const name of ["swap-status-trade-not-on-swap-rail", "swap-status-swap-not-on-trade-rail", "swap-status-not-found"]) {
      expect(clicmd(name).exit).toBe(1)
      expect(clicmd(name).stdout.code).toBe("JOB_NOT_FOUND")
    }
  })

  test("LP is still switched off on Candle's side", () => {
    expect(clicmd("lp-pools-not-enabled").stdout.code).toBe("LP_NOT_ENABLED")
  })
})

describe("payable wallets read the real answers", () => {
  const result = (name: string) => (recordedTee(name).outcome as { result: unknown }).result
  test("the plan, and each key's bound TEE wallet joined to the account's portfolio", () => {
    expect(parseExecutionStatus(result("cli-agent-a-candle_execution_status"), 0)).toMatchObject({ tier: "max", feeBps: 25 })
    const portfolio = result("cli-agent-a-candle_get_portfolio")
    const a = parseProfileWallets(result("cli-agent-a-candle_get_profile_wallets"))!
    expect(a.scope).toBe("selected")
    expect(joinTee(a.rows, portfolio)).toEqual([{ id: "teefakeid1", address: "TeeFake111111111111111111111111111111111111", label: "wallet-label", chain: "solana", active: true }])
    const b = parseProfileWallets(result("cli-agent-b-candle_get_profile_wallets"))!
    expect(joinTee(b.rows, portfolio)).toEqual([])
    // The owner's `keys wallets` answers in the same shape, which the doctor's stranded check reads.
    expect(parseProfileWallets(clicmd("keys-wallets-bound").stdout)!.rows.map((r) => r.id)).toEqual(["teefakeid1"])
    // The signer's reach, as the doctor reads it.
    expect((clicmd("wallets").stdout as unknown as { signers: Record<string, string> }).signers).toEqual({ teefakeid1: "stored" })
  })
})

describe("the fake answers the TEE reads in the real shapes", () => {
  let binDir: string
  let pool: CandleMcpPool
  let stateDir: string
  beforeAll(async () => {
    binDir = mkdtempSync(join(tmpdir(), "chrn-fakebin-"))
    await $`bun build --compile ${join(import.meta.dir, "../../test/fake-candle-mcp.ts")} --outfile ${join(binDir, "candle")}`.quiet()
  })
  afterAll(() => rmSync(binDir, { recursive: true, force: true }))
  afterEach(async () => {
    await pool?.stop()
    rmSync(stateDir, { recursive: true, force: true })
  })

  test("profile wallets and the portfolio's tee array carry every recorded field, for the bound key and the other", async () => {
    stateDir = mkdtempSync(join(tmpdir(), "chrn-recorded-"))
    const teeWallets = [{ id: "teefakeid1", address: "TeeFake111111111111111111111111111111111111", label: "tee-wallet-1", boundKeyPrefix: "aaaaaaaa" }]
    for (const agent of ["a", "b"]) {
      const configDir = candleConfigDir(stateDir, agent)
      mkdirSync(configDir, { recursive: true, mode: 0o700 })
      writeFileSync(join(configDir, "fake-candle.json"), JSON.stringify({ teeWallets }))
    }
    pool = new CandleMcpPool({
      route: "cli",
      path: join(binDir, "candle"),
      stateDir,
      parentEnv: process.env,
      agents: [
        { name: "a", apiKey: `cndl_live_${"a".repeat(43)}` },
        { name: "b", apiKey: `cndl_live_${"b".repeat(43)}` },
      ],
      child: { backoffMs: [100] },
    })
    await pool.start()
    const fields = (o: unknown): string[] => (o && typeof o === "object" ? Object.keys(o).sort() : [])
    for (const [agent, prefix] of [["a", "aaaaaaaa"], ["b", "bbbbbbbb"]] as const) {
      const real = recordedTee(`cli-agent-${agent}-candle_get_profile_wallets`).outcome as { kind: "ok"; result: { wallets: unknown[] } }
      const fake = (await pool.for(agent).call("candle_get_profile_wallets", { keyPrefix: prefix })) as { kind: "ok"; result: { wallets: unknown[] } }
      expect(fake.kind).toBe("ok")
      expect(fields(fake.result)).toEqual(fields(real.result))
      expect(fake.result.wallets).toHaveLength(real.result.wallets.length)
      if (real.result.wallets.length > 0) expect(fields(fake.result.wallets[0])).toEqual(fields(real.result.wallets[0]))
    }
    const realTee = (recordedTee("cli-agent-a-candle_get_portfolio").outcome as { kind: "ok"; result: { tee: unknown[] } }).result.tee[0]
    const fakePortfolio = (await pool.for("b").call("candle_get_portfolio", {})) as { kind: "ok"; result: { tee: unknown[] } }
    expect(fields(fakePortfolio.result.tee[0])).toEqual(fields(realTee))
    // Without a prefix the real server refuses at validation, as recorded.
    const missing = await pool.for("a").call("candle_get_profile_wallets", {})
    expect(missing).toMatchObject({ kind: "error", code: "MCP_VALIDATION" })
  })
})
