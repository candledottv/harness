// Hands off, live: real Claude Code, and Pi on an OpenRouter model, through a real
// core, the real shim and the fake Candle, with the embedded wallet set to trade inside limits ($1.50 a trade,
// $5.00 a day without a card) by the person. One conversation:
//   - "what can you do without asking me?" is answered from harness_limits, naming the figure;
//   - a $1 buy and a 1-token sell run with no card, and the replies say so;
//   - a $3 buy is a card, and the reply says it waits on the person and why;
//   - asked to hold back, the agent proposes the narrowing card, the person approves it, and it takes.
// Each turn costs a little of your Claude subscription or the OpenRouter key.
//   bun run test:live src/core/hands-off.live.test.ts
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, testEngine, until } from "../../test/core-fixture"
import type { EngineId } from "../engine/engine"
import type { AutonomyTopic } from "./autonomy"

const MOON = "MoonFake11111111111111111111111111111111111"
const FAKE_WALLET = "WalletFake111111111111111111111111111111111"
const T = 300_000
const KEY_FILE = join(homedir(), ".config/candle-harness-engines/openrouter-key")
const PI_MODEL = process.env.PI_LIVE_MODEL ?? "openrouter/anthropic/claude-haiku-5.5"

const cores: TestCore[] = []
const scratch: string[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
})
afterAll(() => {
  cleanupHomes()
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

const lastOf = <T>(client: { events: { topic: string; data: unknown }[] }, topic: string) => [...client.events].reverse().find((e) => e.topic === topic)?.data as T | undefined

async function live(engine: EngineId) {
  mkdirSync(join(homedir(), ".cache"), { recursive: true })
  let env: Record<string, string | undefined> = process.env
  if (engine === "pi") {
    const dir = mkdtempSync(join(homedir(), ".cache/chrn-pidir-"))
    scratch.push(dir)
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: readFileSync(KEY_FILE, "utf8").trim() } }), { mode: 0o600 })
    env = { ...process.env, PI_CODING_AGENT_DIR: dir }
  }
  const c = await startTestCore({ env }, { prefix: join(homedir(), ".cache/chrn-h-"), config: { mode: "live", engine: { ...testEngine, claude: { path: "claude" }, pi: { path: "pi" }, default: engine }, hacc: { enabled: false } } })
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["agent", "autonomy", "cards"] })
  await until(() => c.core.engine.lastCheck(engine) !== undefined, 60_000)
  if (engine === "pi") expect((await view.request("engine.choose", { agent: "momentum", engine: "pi", model: PI_MODEL })).error).toBeUndefined()
  await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.some((w) => w.wallet === FAKE_WALLET) === true, 30_000)
  expect((await view.request("autonomy.set", { wallet: "embedded", setting: "inside", perTradeUsd: 1.5, perDayUsd: 5 })).error).toBeUndefined()

  const events = () => view.events.filter((e) => e.topic === "agent" && !e.snapshot).map((e) => e.data as Record<string, unknown>)
  const ask = async (text: string) => {
    const before = events().filter((e) => e.type === "ended").length
    const from = events().length
    const seq = c.core.journal.rows().at(-1)?.seq ?? 0
    await view.request("agent.send", { text })
    await until(() => events().filter((e) => e.type === "ended").length > before, T)
    const turn = events().slice(from)
    const rows = c.core.journal.rows().filter((r) => r.seq > seq)
    const how = new Map(rows.filter((r) => r.type === "card.approved").map((r) => [r.cardId, r.how]))
    const cards = rows.filter((r) => r.type === "card.created").map((r) => ({ cardId: String(r.cardId), kind: r.kind, side: r.side, how: how.get(r.cardId) }))
    const out = { tools: turn.filter((e) => e.type === "tool_call").map((e) => String(e.name)), reply: String(turn.find((e) => e.type === "ended")!.reply), cards }
    console.log(`\n${engine} > ${text}\n  tools ${JSON.stringify(out.tools)}\n  cards ${JSON.stringify(cards)}\n< ${out.reply}`)
    return out
  }
  return { c, view, ask }
}

const engines: EngineId[] = ["claude-code", ...(existsSync(KEY_FILE) ? (["pi"] as const) : [])]

describe.each(engines)("hands off on %s", (engine) => {
  test(
    "what runs without asking, a buy and a sell with no card, a buy a figure sends to a card, and a narrowing card",
    async () => {
      const { c, view, ask } = await live(engine)

      const what = await ask("What can you do without asking me?")
      expect(what.tools.some((t) => t.includes("harness_limits"))).toBe(true)
      expect(what.reply).toMatch(/\$1\.50/)
      expect(what.cards).toEqual([])

      const buy = await ask(`Buy $1 of ${MOON} (MOON). That's the mint, already checked.`)
      expect(buy.cards.filter((k) => k.side === "buy")).toMatchObject([{ how: "inside-limits" }])
      expect(buy.reply).toMatch(/without (a|any) card|no card|inside .{0,30}limits|within .{0,30}limits/i)

      const sell = await ask("Now sell 1 MOON of it, just one token.")
      expect(sell.cards.filter((k) => k.side === "sell")).toMatchObject([{ how: "inside-limits" }])

      const over = await ask("Buy $3 more of MOON.")
      const overCards = over.cards.filter((k) => k.side === "buy")
      expect(overCards).toHaveLength(1)
      expect(overCards[0]!.how).toBeUndefined()
      expect(over.reply).toMatch(/card|approv/i)
      expect(over.reply).toMatch(/\$1\.50|limit|figure|over|exceed|above/i)
      // The person rejects it, so it doesn't sit in the next turns.
      await view.request("cards.reject", { cardId: overCards[0]!.cardId })

      const hold = await ask("Hold back for now: from here on, ask me before every trade from the embedded wallet.")
      expect(hold.tools.some((t) => t.includes("harness_limits"))).toBe(true)
      const narrowing = hold.cards.filter((k) => k.kind === "autonomy")
      expect(narrowing).toHaveLength(1)
      const card = c.core.cards.get(narrowing[0]!.cardId)!
      expect(card.display.title).toBe("LESS AUTONOMY · embedded: ask every time")
      await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })
      await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.find((w) => w.wallet === FAKE_WALLET)?.setting === "ask")
    },
    T * 6,
  )
})
