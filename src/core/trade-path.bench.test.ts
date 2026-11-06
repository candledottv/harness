// The trade path's speed: from the key press (cards.approve) to the moment Candle's MCP child receives
// the call, with both fsyncs (card.approved, operation.submitting) included and the network excluded.
// Real card book, operations, journal on disk and MCP child; the fake server stamps when each call
// arrives. The bar: p95 under 50 ms across 200 runs. On the TEE route the same bar
// holds from the press to the CLI's spawn, with a stand-in CLI that answers a fill at once. A trade with no
// card holds it from the agent's tool call, beside the typed-instant path.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { $ } from "bun"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Redactor } from "../shared/redact"
import { AgentStatusBook } from "./agent-status"
import { CandleCli } from "./candle-cli"
import { candleConfigDir, CandleMcpPool } from "./candle-mcp"
import { CardBook } from "./cards"
import { CliTrades } from "./cli-trade"
import { Operations } from "./execute"
import { Journal } from "./journal"
import { byWalletWithoutCard, DaySpend, Limits } from "./limits"
import { Markets } from "./markets"
import { PriceBook } from "./prices"
import { Pricing } from "./pricing"
import { readTrade } from "./reconcile"

const MOON = "MoonFake11111111111111111111111111111111111"
const RUNS = 200
let dir: string
let pool: CandleMcpPool
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "chrn-bench-"))
  const bin = join(dir, "candle")
  await $`bun build --compile ${join(import.meta.dir, "../../test/fake-candle-mcp.ts")} --outfile ${bin}`.quiet()
  mkdirSync(join(dir, "state"), { mode: 0o700 })
  pool = new CandleMcpPool({ route: "cli", path: bin, stateDir: join(dir, "state"), parentEnv: process.env, agents: [{ name: "momentum", apiKey: `cndl_live_${"b".repeat(40)}` }] })
  await pool.start()
})
afterAll(async () => {
  await pool.stop()
  rmSync(dir, { recursive: true, force: true })
})

test(`approve to the child receiving the call: p95 under 50 ms across ${RUNS} runs`, async () => {
  const journal = await Journal.open({ path: join(dir, "journal.jsonl"), redactor: new Redactor(), account: "acct_fake", now: Date.now })
  const status = new AgentStatusBook({ pool, now: Date.now })
  await status.refresh("momentum")
  const prices = new PriceBook({ read: () => pool.for("momentum").call("candle_get_portfolio", {}), now: Date.now })
  await prices.refresh()
  const spend = new DaySpend()
  const ops = new Operations({ journal, pool, now: Date.now })
  const book = new CardBook({
    journal,
    account: "acct_fake",
    now: Date.now,
    mode: () => "live",
    agents: () => ["momentum"],
    keyPrefix: () => undefined,
    status,
    markets: new Markets({ pool }),
    spendAsset: () => "SOL",
    holding: async () => "none",
    pricing: new Pricing({ call: (agent, tool, args) => pool.for(agent).call(tool, args), tools: () => [], now: Date.now, config: { source: "market", quoteTool: "candle_quote" }, book: prices }),
    limits: new Limits({ limitsFor: () => ({ perTradeUsd: 10, perDayUsd: 50 }), spend }),
    spend,
    paused: () => false,
    execute: (card) => ops.execute(card),
  })
  const client = { clientId: "h1", role: "harness" as const, agent: "momentum" }
  const pressedAt = new Map<string, number>()
  for (let i = 0; i < RUNS; i++) {
    // Sells, so the day limit never stops the run; a different amount each time, so no card is a duplicate.
    const card = await book.propose({ client, agent: "momentum", tool: "candle_trade", args: { mint: MOON, side: "sell", amount: `1.${i}` }, params: { mint: MOON, side: "sell", amount: `1.${i}` }, kind: "trade", idKey: "clientTradeId" })
    pressedAt.set(card.opId, Date.now())
    const result = await book.approve("v1", card.cardId, card.cardHash)
    expect(result.kind).toBe("submitted")
  }
  const calls = readFileSync(join(candleConfigDir(join(dir, "state"), "momentum"), "fake-candle-calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { name: string; args: { clientTradeId?: string }; at: number })
    .filter((c) => c.name === "candle_trade")
  expect(calls).toHaveLength(RUNS)
  const latencies = calls.map((c) => c.at - pressedAt.get(c.args.clientTradeId!)!).sort((a, b) => a - b)
  const p95 = latencies[Math.ceil(RUNS * 0.95) - 1]!
  console.log(`trade path: p50 ${latencies[RUNS / 2]} ms, p95 ${p95} ms, max ${latencies.at(-1)} ms`)
  expect(p95).toBeLessThan(50)
  await journal.close()
}, 60_000)

// A trade with no card is the typed-instant path taken for the agent's proposal, so from the
// tool call to Candle's child it runs no step a card's approval doesn't. Measured three ways over the same buys:
// with no card, typed-instant, and a card approved by a press (from the press).
test(`a trade with no card: the tool call to the child receiving it, against typed-instant, p95 under 50 ms across ${RUNS} runs`, async () => {
  const journal = await Journal.open({ path: join(dir, "journal-alone.jsonl"), redactor: new Redactor(), account: "acct_fake", now: Date.now })
  const status = new AgentStatusBook({ pool, now: Date.now })
  await status.refresh("momentum")
  const prices = new PriceBook({ read: () => pool.for("momentum").call("candle_get_portfolio", {}), now: Date.now })
  await prices.refresh()
  const spend = new DaySpend()
  const walletSpend = new DaySpend(byWalletWithoutCard)
  const ops = new Operations({ journal, pool, now: Date.now })
  const book = new CardBook({
    journal,
    account: "acct_fake",
    now: Date.now,
    mode: () => "live",
    agents: () => ["momentum"],
    keyPrefix: () => undefined,
    status,
    markets: new Markets({ pool }),
    spendAsset: () => "SOL",
    holding: async () => "none",
    pricing: new Pricing({ call: (agent, tool, args) => pool.for(agent).call(tool, args), tools: () => [], now: Date.now, config: { source: "market", quoteTool: "candle_quote" }, book: prices }),
    limits: new Limits({ limitsFor: () => ({ perTradeUsd: 1_000_000, perDayUsd: 1_000_000 }), spend }),
    spend,
    walletSpend,
    autonomy: { get: () => ({ setting: "inside", perTradeUsd: 1_000_000, perDayUsd: 1_000_000 }) },
    paused: () => false,
    execute: (card) => ops.execute(card),
  })
  const client = { clientId: "h1", role: "harness" as const, agent: "momentum" }
  const started = new Map<string, number>()
  const paths = { alone: [] as string[], instant: [] as string[] }
  for (let i = 0; i < RUNS; i++) {
    for (const path of ["alone", "instant"] as const) {
      // Buys, so the wallet's figures are checked; a different amount each time, so no card is a duplicate.
      const amount = `0.0001${path === "alone" ? 1 : 2}${i}`
      const at = Date.now()
      const card = await book.propose({ client, agent: "momentum", tool: "candle_trade", args: { mint: MOON, side: "buy", amount }, params: { mint: MOON, side: "buy", amount }, kind: "trade", idKey: "clientTradeId" })
      started.set(card.opId, at)
      paths[path].push(card.opId)
      if (path === "alone") expect((await book.runWithoutCard(card, client)).ran?.kind).toBe("submitted")
      else expect((await book.approve("v1", card.cardId, card.cardHash, "instant")).kind).toBe("submitted")
    }
  }
  const received = new Map(
    readFileSync(join(candleConfigDir(join(dir, "state"), "momentum"), "fake-candle-calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { name: string; args: { clientTradeId?: string }; at: number })
      .filter((c) => c.name === "candle_trade" && c.args.clientTradeId !== undefined)
      .map((c) => [c.args.clientTradeId!, c.at]),
  )
  const p95 = (ids: string[]) => {
    const l = ids.map((id) => received.get(id)! - started.get(id)!).sort((a, b) => a - b)
    return { p50: l[RUNS / 2]!, p95: l[Math.ceil(RUNS * 0.95) - 1]!, max: l.at(-1)! }
  }
  const alone = p95(paths.alone)
  const instant = p95(paths.instant)
  console.log(`tool call to Candle's child: no card p50 ${alone.p50} ms, p95 ${alone.p95} ms, max ${alone.max} ms; typed-instant p50 ${instant.p50} ms, p95 ${instant.p95} ms, max ${instant.max} ms`)
  expect(alone.p95).toBeLessThan(50)
  expect(book.list().filter((c) => paths.alone.includes(c.opId)).every((c) => c.approvedHow === "inside-limits")).toBe(true)
  await journal.close()
}, 60_000)

test(`TEE route: approve to the CLI's spawn, p95 under 50 ms across ${RUNS} runs`, async () => {
  const TEE = "TeeFake111111111111111111111111111111111111"
  const cliBin = join(dir, "candle-cli.sh")
  writeFileSync(cliBin, `#!/bin/sh\necho '{"success":true,"status":"executed","signature":"S","kind":"trade"}'\n`)
  chmodSync(cliBin, 0o755)
  const journal = await Journal.open({ path: join(dir, "journal-tee.jsonl"), redactor: new Redactor(), account: "acct_fake", now: Date.now })
  const status = new AgentStatusBook({ pool, now: Date.now })
  await status.refresh("momentum")
  const prices = new PriceBook({ read: () => pool.for("momentum").call("candle_get_portfolio", {}), now: Date.now })
  await prices.refresh()
  const real = new CandleCli({ cliPath: cliBin, keyFor: () => `cndl_live_${"b".repeat(40)}`, parentEnv: process.env })
  // Stamped as the run starts, just before the spawn: the CLI's own start-up is its work, not the core's.
  const spawnedAt = new Map<string, number>()
  const cli = {
    runExact: (input: Parameters<CandleCli["runExact"]>[0]) => {
      spawnedAt.set(input.argv[input.argv.indexOf("--client-trade-id") + 1]!, Date.now())
      return real.runExact(input)
    },
  }
  const trades = new CliTrades({ cli, redactor: new Redactor(), journal, readTrade: (agent, opId) => readTrade(pool.for(agent), opId) })
  const spend = new DaySpend()
  const ops = new Operations({ journal, pool, now: Date.now, cliTrades: trades })
  const book = new CardBook({
    journal,
    account: "acct_fake",
    now: Date.now,
    mode: () => "live",
    agents: () => ["momentum"],
    keyPrefix: () => undefined,
    status,
    markets: new Markets({ pool }),
    spendAsset: () => "SOL",
    holding: async () => "none",
    pricing: new Pricing({ call: (agent, tool, args) => pool.for(agent).call(tool, args), tools: () => [], now: Date.now, config: { source: "market", quoteTool: "candle_quote" }, book: prices }),
    limits: new Limits({ limitsFor: () => ({ perTradeUsd: 10, perDayUsd: 50 }), spend }),
    spend,
    paused: () => false,
    wallets: { payer: () => ({ ok: true, kind: "tee", address: TEE, id: "tee1", label: "tee-one", chain: "solana" }) },
    execute: (card) => ops.execute(card),
  })
  const client = { clientId: "h1", role: "harness" as const, agent: "momentum" }
  const latencies: number[] = []
  for (let i = 0; i < RUNS; i++) {
    const card = await book.propose({ client, agent: "momentum", tool: "candle_trade", args: { mint: MOON, side: "sell", amount: `1.${i}`, wallet: "tee-one" }, params: { mint: MOON, side: "sell", amount: `1.${i}`, wallet: "tee-one" }, kind: "trade", idKey: "clientTradeId" })
    expect(card.route).toBe("cli")
    const pressed = Date.now()
    const result = await book.approve("v1", card.cardId, card.cardHash)
    expect(result.kind === "submitted" && result.operation.state).toBe("succeeded")
    latencies.push(spawnedAt.get(card.opId)! - pressed)
  }
  latencies.sort((a, b) => a - b)
  const p95 = latencies[Math.ceil(RUNS * 0.95) - 1]!
  console.log(`TEE route: p50 ${latencies[RUNS / 2]} ms, p95 ${p95} ms, max ${latencies.at(-1)} ms`)
  expect(p95).toBeLessThan(50)
  await journal.close()
}, 60_000)
