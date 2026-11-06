// The Journal's search beside the trade path: a 200,000-row journal, a search
// that matches nothing (the slowest: it reads every row), run again and again while the press-to-submit
// bench runs on the same core's journal. The trade path's bar still holds: p95 under 50 ms across 200 runs.
// If it didn't, the scan would move to a worker.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { $ } from "bun"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Redactor } from "../shared/redact"
import { AgentStatusBook } from "./agent-status"
import { candleConfigDir, CandleMcpPool } from "./candle-mcp"
import { CardBook } from "./cards"
import { Operations } from "./execute"
import { Journal } from "./journal"
import { queryJournal } from "./journal-query"
import { DaySpend, Limits } from "./limits"
import { Markets } from "./markets"
import { PriceBook } from "./prices"
import { Pricing } from "./pricing"

const MOON = "MoonFake11111111111111111111111111111111111"
const ROWS = 200_000
const RUNS = 200
let dir: string
let pool: CandleMcpPool

/** A journal of `n` rows in the shapes the core writes: card lives, turns, paper trades, picks and the core's own. */
function writeJournal(path: string, n: number): void {
  const at = (i: number) => new Date(Date.parse("2026-09-01T00:00:00Z") + i * 9_000).toISOString()
  const base = (i: number, type: string) => ({ seq: i + 1, at: at(i), type, account: "acct_fake", mode: "live", agent: "momentum" })
  const lines: string[] = []
  for (let i = 0; i < n; ) {
    const k = Math.floor(i / 8)
    const card = `card_${k}`
    const op = `op_${k}`
    const block = [
      { ...base(i, "card.created"), cardId: card, opId: op, role: "harness", kind: "trade", tool: "candle_trade", params: { mint: MOON, side: "buy", amount: "0.05" }, mint: MOON, side: "buy", wallet: "Embed1111", headline: "Buy 0.05 SOL of MOON", title: "Buy MOON", value: { usd: 7.5 } },
      { ...base(i + 1, "card.approved"), cardId: card, opId: op, how: "enter", side: "buy", usd: 7.5 },
      { ...base(i + 2, "operation.submitting"), opId: op, cardId: card, kind: "trade", tool: "candle_trade", params: { mint: MOON, side: "buy", amount: "0.05" } },
      { ...base(i + 3, "operation.succeeded"), opId: op, result: { status: "executed", signature: "S".repeat(88) } },
      { ...base(i + 4, "agent.turn_started"), turnId: `t_${k}`, engine: "claude-code", model: "opus" },
      { ...base(i + 5, "agent.turn"), turnId: `t_${k}`, user: "what do you make of MOON?", reply: "MOON's volume is up on the hour, and three wallets bought. ".repeat(4), tools: ["candle_get_token", "hacc_token"], outcome: "done", steps: 3 },
      { ...base(i + 6, "view.picked"), mint: MOON, symbol: "MOON", from: "feed, by a click" },
      { ...base(i + 7, "client.attached"), clientId: `v${k}`, role: "view", clientName: "view" },
    ]
    for (const row of block.slice(0, n - i)) lines.push(JSON.stringify(row))
    i += block.length
  }
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "chrn-jbench-"))
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

test(`a search over ${ROWS} rows beside the trade path: p95 still under 50 ms across ${RUNS} runs`, async () => {
  const path = join(dir, "journal.jsonl")
  writeJournal(path, ROWS)
  const redactor = new Redactor()
  const journal = await Journal.open({ path, redactor, account: "acct_fake", now: Date.now })
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

  // The search, again and again until the presses are done: the slowest kind, which reads every row.
  let searching = true
  const scans: { ms: number; scanned: number }[] = []
  const search = (async () => {
    while (searching) {
      const started = performance.now()
      const page = await queryJournal({ text: "nothing recorded says this" }, { memory: () => journal.rows(), tail: journal.tail, path, redactor, symbolOf: () => undefined })
      expect(page.entries).toEqual([])
      scans.push({ ms: performance.now() - started, scanned: page.scanned })
    }
  })()

  const client = { clientId: "h1", role: "harness" as const, agent: "momentum" }
  const pressedAt = new Map<string, number>()
  // A moment for the first scan to be under way.
  await new Promise((resolve) => setTimeout(resolve, 50))
  for (let i = 0; i < RUNS; i++) {
    const card = await book.propose({ client, agent: "momentum", tool: "candle_trade", args: { mint: MOON, side: "sell", amount: `1.${i}` }, params: { mint: MOON, side: "sell", amount: `1.${i}` }, kind: "trade", idKey: "clientTradeId" })
    pressedAt.set(card.opId, Date.now())
    const result = await book.approve("v1", card.cardId, card.cardHash)
    expect(result.kind).toBe("submitted")
  }
  searching = false
  await search

  const calls = readFileSync(join(candleConfigDir(join(dir, "state"), "momentum"), "fake-candle-calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { name: string; args: { clientTradeId?: string }; at: number })
    .filter((c) => c.name === "candle_trade" && pressedAt.has(c.args.clientTradeId!))
  expect(calls).toHaveLength(RUNS)
  const latencies = calls.map((c) => c.at - pressedAt.get(c.args.clientTradeId!)!).sort((a, b) => a - b)
  const p95 = latencies[Math.ceil(RUNS * 0.95) - 1]!
  const whole = scans.filter((s) => s.scanned >= ROWS)
  console.log(`journal of ${ROWS} rows (${(statSync(path).size / 1e6).toFixed(0)} MB): ${scans.length} searches, each ${whole.map((s) => Math.round(s.ms)).join(", ")} ms; trade path beside it p50 ${latencies[RUNS / 2]} ms, p95 ${p95} ms, max ${latencies.at(-1)} ms`)
  // Every search read the whole journal, and at least one ran start to end while the presses went.
  expect(whole.length).toBeGreaterThanOrEqual(1)
  expect(p95).toBeLessThan(50)
  await journal.close()
}, 180_000)
