// The kill switch, through a real core: pressed during an agent turn, with cards open and a call in flight.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupHomes, fakeCandle, startTestCore, type TestCore, testConfig, until } from "../../test/core-fixture"
import { scripted } from "../../test/scripted-engine"
import { connectTestClient } from "../../test/core-test-client"
import { Redactor } from "../shared/redact"
import { PROTOCOL_VERSION } from "../shared/rpc"
import { candleConfigDir } from "./candle-mcp"
import { startCore } from "./core-main"
import { Journal } from "./journal"
import { KILL_WORDING, type KillDeps, type KillReport, KillSwitch, pausedInJournal, UNSAVED_WORDS } from "./kill"
import { readViewToken } from "./tokens"
import { DaySpend } from "./limits"
import { sequencedFailure } from "./reconcile"

const MOON = "MoonFake11111111111111111111111111111111111"
// The fake Candle's embedded wallets, Solana's and the EVM one.
const FAKE_WALLET = "WalletFake111111111111111111111111111111111"
const FAKE_EVM_WALLET = "0x00000000000000000000000000000000000Fa4e1"
const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
})
afterAll(cleanupHomes)

/** A turn that runs until it's cancelled. */
const waitsForCancel = scripted([
  async (_t, push, cancelled) => {
    push({ type: "text", delta: "Watching the market " })
    await cancelled
  },
])

async function core() {
  const c = await startTestCore({ engine: { start: waitsForCancel.start, version: () => ({ ok: true, version: "2.1.310" }), processes: () => [], leftoverDelayMs: 10 } })
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["agent", "activity", "status"] })
  const script = (agent: string, value: unknown) => {
    const dir = candleConfigDir(c.p.stateDir, agent)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "fake-candle.json"), JSON.stringify(value))
  }
  const propose = async (args: Record<string, unknown>, tool = "candle_trade") => {
    const r = await view.request("cards.propose", { tool, args })
    if (r.error) throw new Error(JSON.stringify(r.error))
    return r.result as { cardId: string; cardHash: string; state: string }
  }
  return { c, view, script, propose }
}

const replacedId = (c: TestCore, cardId: string) => c.core.journal.rows().find((r) => r.type === "card.withdrawn" && r.cardId === cardId)?.replacedBy

const errorCode = (r: { error?: { data?: { code: string } } }) => r.error?.data?.code

describe("kill", () => {
  test("mid-turn, with a buy, a swap and a sell open and a call in flight: it stops the turn and the spending, and leaves the way out", async () => {
    const { c, view, script, propose } = await core()

    // A call in flight: an approved buy whose answer never comes.
    script("momentum", { tools: { candle_trade: "hang" } })
    const sent = await propose({ mint: MOON, side: "buy", amount: "0.01" })
    void view.request("cards.approve", { cardId: sent.cardId, cardHash: sent.cardHash })
    await until(() => c.core.operations.list().some((op) => op.state === "submitting"))
    script("momentum", {})

    const buy = await propose({ mint: MOON, side: "buy", amount: "0.02" })
    const swap = await propose({ from: "SOL", to: "USDC", amount: "0.01" }, "candle_swap")
    const sell = await propose({ mint: MOON, side: "sell", amount: "1" })
    await view.request("agent.send", { text: "keep an eye on MOON" })
    await until(() => view.events.some((e) => e.topic === "agent" && (e.data as { type?: string } | null)?.type === "started"))

    const killed = await view.request("kill", {})
    const { report, already } = killed.result as { report: KillReport; already: boolean }
    expect(already).toBe(false)

    // The turn ended, cancelled.
    expect(report.stopped.turns).toEqual([expect.objectContaining({ agent: "momentum" })])
    await until(() => view.events.some((e) => e.topic === "agent" && (e.data as { type?: string; outcome?: string } | null)?.outcome === "cancelled"))
    // The buy and the swap were withdrawn; the sell stays.
    expect(report.stopped.cards.map((card) => card.cardId).sort()).toEqual([buy.cardId, swap.cardId].sort())
    expect(c.core.cards.get(buy.cardId)!.state).toBe("withdrawn")
    expect(c.core.cards.get(swap.cardId)!.state).toBe("withdrawn")
    // Journalled as the reason, which the agent's record and Activity read (not as `by`).
    expect(c.core.journal.rows().find((r) => r.type === "card.withdrawn" && r.cardId === buy.cardId)).toMatchObject({ reason: "kill_switch" })
    // The sell stays, as a new card at a fresh price with its full 60 s; the old one is withdrawn (a kept
    // sell could expire while the report was read).
    const old = c.core.cards.get(sell.cardId)!
    expect(old).toMatchObject({ state: "withdrawn", replacedBy: replacedId(c, sell.cardId) })
    const replaced = c.core.journal.rows().find((r) => r.type === "card.withdrawn" && r.cardId === sell.cardId)!
    expect(replaced).toMatchObject({ reason: "kill_switch_fresh" })
    const fresh = c.core.cards.get(String(replaced.replacedBy))!
    expect(fresh).toMatchObject({ state: "awaiting_approval", side: "sell", agent: "momentum" })
    expect(Date.parse(fresh.expiresAt)).toBeGreaterThan(Date.parse(old.expiresAt))
    // Priced again: its card.created comes after kill.on.
    const seqOf = (pred: (r: { type: string; cardId?: unknown }) => boolean) => c.core.journal.rows().find(pred)!.seq
    expect(seqOf((r) => r.type === "card.created" && r.cardId === fresh.cardId)).toBeGreaterThan(seqOf((r) => r.type === "kill.on"))
    // It says which card it replaces, so Activity doesn't call it a second proposal.
    expect(c.core.journal.rows().find((r) => r.type === "card.created" && r.cardId === fresh.cardId)).toMatchObject({ replaces: sell.cardId })
    expect(report.stillOpen).toEqual([expect.objectContaining({ cardId: fresh.cardId, title: expect.stringContaining("SELL 1 MOON") })])
    // The call in flight is listed, and carries on: never abandoned.
    expect(report.inFlight).toEqual([expect.objectContaining({ cardId: sent.cardId, state: "submitting", title: expect.stringContaining("BUY 0.01 SOL") })])
    expect(c.core.operations.list().find((op) => op.cardId === sent.cardId)!.state).not.toBe("abandoned")
    // Where things stand, from what the core already read; what it didn't stop, and how to resume.
    expect(report.standing.spentToday.find((s) => s.agent === "momentum")).toMatchObject({ perDayUsd: 50 })
    // The P&L window's figure, the status bar's, named by its window.
    expect(report.standing.pnl).toMatchObject({ label: "24h" })
    expect(report.notStopped.wording).toBe(KILL_WORDING)
    // The Harness's own bots are held, as the report's held line says: what isn't stopped is outside it.
    expect(KILL_WORDING).toContain("holds its bots' buys (their sells and exits still go)")
    expect(KILL_WORDING).not.toMatch(/^.*\. Bots and other apps/)
    expect(report.notStopped.steps.find((s) => s.agent === "momentum")).toMatchObject({ takeOffWallet: "candle keys self embedded-wallet deny" })
    expect(report.resume).toContain("resume")

    // The report went out on activity, the status says paused, and it's journalled.
    expect(view.events.some((e) => e.topic === "activity" && (e.data as { kind?: string } | null)?.kind === "kill.report")).toBe(true)
    await until(() => view.events.some((e) => e.topic === "status" && (e.data as { paused?: boolean } | null)?.paused === true))
    expect(c.core.journal.rows().filter((r) => r.type === "kill.on")).toHaveLength(1)
    expect(c.core.journal.rows().some((r) => r.type === "kill.report")).toBe(true)

    // The fresh sell runs on one press; the old card can't be approved.
    expect((await view.request("cards.approve", { cardId: sell.cardId, cardHash: sell.cardHash })).result).toBeUndefined()
    const approved = await view.request("cards.approve", { cardId: fresh.cardId, cardHash: fresh.cardHash })
    expect(approved.result).toMatchObject({ kind: "submitted", operation: { state: "succeeded" } })
  })

  test("a kill pressed while a buy's approval is being written: the buy is refused before it's sent, and the report lists it", async () => {
    const { c, view, propose } = await core()
    const calls = () => {
      const file = join(candleConfigDir(c.p.stateDir, "momentum"), "fake-candle-calls.jsonl")
      return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.includes("candle_trade")).length : 0
    }
    const buy = await propose({ mint: MOON, side: "buy", amount: "0.01" })
    const before = calls()
    // The kill lands between the approval's checks and its fsynced card.approved row.
    let report: KillReport | undefined
    const journal = c.core.journal
    const append = journal.append.bind(journal)
    journal.append = (async (row: Parameters<typeof append>[0]) => {
      if (row.type === "card.approved" && !report) report = ((await view.request("kill", {})).result as { report: KillReport }).report
      return append(row)
    }) as typeof journal.append
    const approved = await view.request("cards.approve", { cardId: buy.cardId, cardHash: buy.cardHash })
    expect(approved.result).toMatchObject({ kind: "submitted", operation: { state: "refused", error: { code: "PAUSED" } } })
    expect(calls()).toBe(before)
    expect(c.core.journal.rows().find((r) => r.type === "operation.refused" && r.cardId === buy.cardId)).toMatchObject({ error: { code: "PAUSED" } })
    // Mid-approval, the kill couldn't withdraw it, so it's in flight in the report until it's refused.
    expect(report!.inFlight).toEqual([expect.objectContaining({ cardId: buy.cardId })])
    const shown = (await view.request("kill", {})).result as { report: KillReport }
    expect(shown.report.inFlight).toEqual([expect.objectContaining({ cardId: buy.cardId, state: "refused" })])
    // Its day's spend went back.
    expect(c.core.cards.get(buy.cardId)!.operation).toMatchObject({ state: "refused" })
  })

  test("while paused: buys and swaps are refused, typed or the agent's, before anything is read; sells, reads and less-access work", async () => {
    const { c, view, propose } = await core()
    await view.request("kill", {})
    const callsBefore = existsSync(join(candleConfigDir(c.p.stateDir, "momentum"), "fake-candle-calls.jsonl"))
      ? readFileSync(join(candleConfigDir(c.p.stateDir, "momentum"), "fake-candle-calls.jsonl"), "utf8")
      : ""
    const typedBuy = await view.request("cards.propose", { tool: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.01" } })
    expect(errorCode(typedBuy)).toBe("PAUSED")
    expect(errorCode(await view.request("cards.propose", { tool: "candle_swap", args: { from: "SOL", to: "USDC", amount: "0.01" } }))).toBe("PAUSED")
    const callsAfter = existsSync(join(candleConfigDir(c.p.stateDir, "momentum"), "fake-candle-calls.jsonl"))
      ? readFileSync(join(candleConfigDir(c.p.stateDir, "momentum"), "fake-candle-calls.jsonl"), "utf8")
      : ""
    expect(callsAfter).toBe(callsBefore)
    const { client } = await c.harness()
    const agentBuy = await client.request("tools.call", { name: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.01" } })
    expect(JSON.stringify(agentBuy.result)).toContain("PAUSED")
    expect((await propose({ mint: MOON, side: "sell", amount: "1" })).state).toBe("awaiting_approval")
    const read = await client.request("tools.call", { name: "candle_get_wallets", args: {} })
    expect(JSON.stringify(read.result)).not.toContain("PAUSED")
    // Narrowing access, typed: runs at once.
    const revoke = await view.request("cli.run", { argv: ["keys", "revoke", "abc12345"] })
    expect(revoke.error).toBeUndefined()
    expect(c.core.journal.rows().find((r) => r.type === "cli.typed")).toMatchObject({ argv: expect.arrayContaining(["keys", "revoke", "abc12345"]), rule: "less-access" })
  })

  test("it reaches Candle's MCP cards: launches, stakes, profile edits and new posts are withdrawn; unstakes, claims and post deletes stay", async () => {
    const { c, view, propose } = await core()
    const launch = await propose({ name: "Fake Moon", symbol: "FMOON", imageUrl: "https://cdn.example/fake.png" }, "candle_launch_token")
    const stake = await propose({ amountRaw: "1000000" }, "candle_stake")
    const post = await propose({ text: "gm" }, "candle_create_post")
    const profile = await propose({ publicThesis: "fast in" }, "candle_update_profile")
    // A client may hold five open cards: the kept ones come from a second view.
    const other = await c.view()
    const proposeAs = async (args: Record<string, unknown>, tool: string) => {
      const r = await other.request("cards.propose", { tool, args })
      if (r.error) throw new Error(JSON.stringify(r.error))
      return r.result as { cardId: string; cardHash: string }
    }
    const unstake = await proposeAs({ amountRaw: "1000000" }, "candle_unstake")
    const claim = await proposeAs({ mint: MOON }, "candle_claim_fees")
    const remove = await proposeAs({ postId: "post_fake_1" }, "candle_delete_post")
    const { report } = (await view.request("kill", {})).result as { report: KillReport }
    expect(report.stopped.cards.map((card) => card.cardId).sort()).toEqual([launch.cardId, stake.cardId, post.cardId, profile.cardId].sort())
    expect(report.stillOpen.map((card) => card.cardId).sort()).toEqual([unstake.cardId, claim.cardId, remove.cardId].sort())
    // Paused, a new launch is refused when proposed; a claim is still one press.
    const again = await view.request("cards.propose", { tool: "candle_launch_token", args: { name: "Fake Two", symbol: "FTWO", imageUrl: "https://cdn.example/fake.png" } })
    expect(errorCode(again)).toBe("PAUSED")
    const claimed = await other.request("cards.approve", { cardId: claim.cardId, cardHash: claim.cardHash })
    expect(claimed.result).toMatchObject({ kind: "submitted", operation: { state: "succeeded" } })
    expect(c.core.cards.get(launch.cardId)!.state).toBe("withdrawn")
  })

  test("kill is idempotent, and resume allows buys again", async () => {
    const { c, view, propose } = await core()
    await view.request("kill", {})
    expect((await view.request("kill", {})).result).toMatchObject({ paused: true, already: true })
    expect(c.core.journal.rows().filter((r) => r.type === "kill.on")).toHaveLength(1)
    expect((await view.request("resume", {})).result).toEqual({ paused: false, already: false })
    expect((await view.request("resume", {})).result).toEqual({ paused: false, already: true })
    expect(c.core.journal.rows().filter((r) => r.type === "kill.off")).toHaveLength(1)
    expect((await propose({ mint: MOON, side: "buy", amount: "0.01" })).state).toBe("awaiting_approval")
  })

  test("a second kill re-proposes the kept sell again, and the report points at the newest card", async () => {
    const { c, view, propose } = await core()
    const sell = await propose({ mint: MOON, side: "sell", amount: "1" })
    const first = ((await view.request("kill", {})).result as { report: KillReport }).report.stillOpen[0]!.cardId
    const second = ((await view.request("kill", {})).result as { report: KillReport }).report.stillOpen
    expect(second).toHaveLength(1)
    expect(new Set([sell.cardId, first, second[0]!.cardId]).size).toBe(3)
    expect(c.core.cards.list().filter((card) => card.state === "awaiting_approval").map((card) => card.cardId)).toEqual([second[0]!.cardId])
    // Journalled as it now stands, so a restart shows the newest card (not only its card rows).
    const reports = c.core.journal.rows().filter((r) => r.type === "kill.report")
    expect(reports).toHaveLength(2)
    expect(reports[1]).toMatchObject({ again: true, report: { stillOpen: [expect.objectContaining({ cardId: second[0]!.cardId })] } })
    expect(c.core.journal.rows().filter((r) => r.type === "kill.on")).toHaveLength(1)
  })

  test("a harness can't kill or resume", async () => {
    const { c } = await core()
    const { client } = await c.harness()
    expect((await client.request("kill", {})).error).toBeDefined()
    expect((await client.request("resume", {})).error).toBeDefined()
  })

  test("paused survives a restart, and the report is still pinned", async () => {
    const { c, view } = await core()
    await view.request("kill", {})
    const p = c.p
    cores.splice(0)
    await c.close()
    const again = await startCore({ paths: p, config: testConfig(await fakeCandle()), env: process.env, headless: true })
    try {
      const client = await connectTestClient(p.socket)
      await client.request("core.hello", { protocol: PROTOCOL_VERSION, token: (await readViewToken(p.viewToken))!, clientName: "test" })
      expect((await client.request("core.status", {})).result).toMatchObject({ paused: true })
      await client.request("subscribe", { topics: ["activity"] })
      await until(() => client.events.some((e) => e.topic === "activity"))
      expect((client.events.find((e) => e.topic === "activity")!.data as { killReport: KillReport | null }).killReport).toMatchObject({ notStopped: { wording: KILL_WORDING } })
      const buy = await client.request("cards.propose", { tool: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.01" } })
      expect(errorCode(buy)).toBe("PAUSED")
      client.close()
    } finally {
      await again.stop("test")
    }
  })

  test("where you stand, on a Hood account: the embedded EVM wallet is the agents' too, named on Hood, its ETH said as ETH", async () => {
    const TOKEN = "0x00000000000000000000000000000000000b0B31"
    const hood = { evmWei: "500000000000000000", ethUsd: 3_000, evmTokens: [{ mint: TOKEN, amountRaw: "1000000000000000000000", decimals: 18 }], markets: [{ mint: TOKEN, symbol: "HTOK", priceUsd: 2, chain: "hood" }] }
    const c = await startTestCore({}, { candle: { momentum: hood, swing: hood } })
    cores.push(c)
    const view = await c.view()
    await view.request("subscribe", { topics: ["portfolio"] })
    await until(() => view.events.some((e) => e.topic === "portfolio" && JSON.stringify(e.data).includes(FAKE_EVM_WALLET)))
    const { report } = (await view.request("kill", {})).result as { report: KillReport }
    const evm = report.standing.wallets.find((w) => w.wallet === FAKE_EVM_WALLET)
    expect(evm).toMatchObject({ name: "embedded on Hood", nativeSymbol: "ETH", chain: "hood", solUsd: 1_500 })
    expect(evm!.agents.sort()).toEqual(["momentum", "swing"])
    expect(report.standing.wallets.find((w) => w.wallet === FAKE_WALLET)).toMatchObject({ name: "embedded", nativeSymbol: "SOL", chain: "solana" })
  })
})

describe("the state behind paused", () => {
  async function open(rows: { type: string }[], file: unknown, extra: Partial<KillDeps> = {}) {
    const dir = `/tmp/chrn-kill-${crypto.randomUUID().slice(0, 8)}`
    mkdirSync(dir, { recursive: true })
    const journal = await Journal.open({ path: join(dir, "journal.jsonl"), redactor: new Redactor(), account: "acct_fake", now: Date.now })
    for (const row of rows) await journal.append({ ...row, mode: "live" })
    const statePath = join(dir, "kill.json")
    if (file !== undefined) writeFileSync(statePath, JSON.stringify(file))
    const published: KillReport[] = []
    const k = await KillSwitch.open({
      journal,
      mode: () => "live",
      statePath,
      now: Date.now,
      agents: () => ["momentum"],
      cards: { list: () => [], withdrawWhere: async () => [], refreshWhere: async () => [] },
      operations: { list: () => [{ opId: "op1", cardId: "c1", state: "submitting", agent: "momentum" } as never] },
      engine: { cancelAll: async () => [] },
      spend: new DaySpend(),
      limitsFor: () => ({ perDayUsd: 50 }),
      walletsOf: () => [],
      portfolio: () => undefined,
      prices: { usd: () => undefined },
      keyPrefix: () => "momeAb3d",
      publish: (r) => published.push(structuredClone(r)),
      onChange: () => {},
      ...extra,
    })
    return { k, journal, dir, statePath, published }
  }

  test("where you stand lists a known Hood account's embedded wallet Candle couldn't read, as unread; a Solana-only account's stays out", async () => {
    const unread = {
      embedded: [{ chain: "solana", address: FAKE_WALLET, lamports: "2000000000", tokens: [] }],
      tee: [],
      hood: { embedded: [{ address: FAKE_EVM_WALLET, chain: "hood", wei: null, tokens: null }], tee: [], unavailable: [FAKE_EVM_WALLET] },
    }
    const standing = async (chains: readonly ("solana" | "hood")[]) => {
      const { k, journal, dir } = await open([], undefined, { walletsOf: () => [FAKE_WALLET, FAKE_EVM_WALLET], portfolio: () => ({ result: unread, readAt: Date.now() }), chains: () => chains })
      const { report } = await k.kill("v1")
      await journal.close()
      rmSync(dir, { recursive: true, force: true })
      return report.standing.wallets
    }
    const known = (await standing(["solana", "hood"])).find((w) => w.wallet === FAKE_EVM_WALLET)
    expect(known?.name).toBe("embedded on Hood")
    expect(known?.solUsd).toBeNull()
    expect(known?.tokensUsd).toBeNull()
    expect((await standing(["solana"])).map((w) => w.wallet)).toEqual([FAKE_WALLET])
  })

  test("a Hood trade whose job Candle ended isn't in flight: nothing reads it, and its card says what it ended with", async () => {
    const job = { status: "failed", errorCode: "SWAP_FAILED", operation: { legs: [{ kind: "approve", status: "confirmed" }, { kind: "trade", status: "failed" }] } }
    const ended = { opId: "op-h", cardId: "c-h", state: "unknown", agent: "momentum", kind: "trade", result: job, error: sequencedFailure(job) }
    const open1 = { opId: "op-o", cardId: "c-o", state: "unknown", agent: "momentum", kind: "trade" }
    const { k, journal, dir } = await open([], undefined, { operations: { list: () => [ended, open1] as never } })
    const { report } = await k.kill("v1")
    await journal.close()
    rmSync(dir, { recursive: true, force: true })
    expect(report.inFlight.map((l) => l.opId)).toEqual(["op-o"])
  })

  test("either the file or the journal saying paused means paused", async () => {
    const cases: [{ type: string }[], unknown, boolean][] = [
      [[], undefined, false],
      [[{ type: "kill.on" }], undefined, true], // the file was lost
      [[], { paused: true }, true], // the kill.on row is outside the journal's window
      [[{ type: "kill.on" }, { type: "kill.off" }], { paused: true }, true], // a crash between resume's two writes
      [[{ type: "kill.on" }, { type: "kill.off" }], { paused: false }, false],
    ]
    for (const [rows, file, paused] of cases) {
      const { k, journal, dir } = await open(rows, file)
      expect(k.paused()).toBe(paused)
      await journal.close()
      rmSync(dir, { recursive: true, force: true })
    }
    expect(pausedInJournal([{ type: "kill.on" }, { type: "kill.off" }, { type: "kill.on" }] as never)).toBe(true)
  })

  test("kill writes the file 0600 before the journal row; resume clears it", async () => {
    const { k, journal, dir, statePath } = await open([], undefined)
    await k.kill("v1")
    expect(JSON.parse(readFileSync(statePath, "utf8")).paused).toBe(true)
    expect(require("node:fs").statSync(statePath).mode & 0o777).toBe(0o600)
    await k.resume("v1")
    expect(JSON.parse(readFileSync(statePath, "utf8")).paused).toBe(false)
    expect(existsSync(statePath)).toBe(true)
    await journal.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("a pause that can't be written still stops the turns and the cards, says it isn't saved, and is saved by the next kill", async () => {
    const base = await open([], undefined)
    const missing = join(base.dir, "gone")
    let diskFull = true
    const stops: string[] = []
    const failing = { rows: () => base.journal.rows(), append: async (row: never) => (diskFull ? Promise.reject(new Error("ENOSPC")) : base.journal.append(row)) } as unknown as Journal
    const spare = await open([], undefined, {
      journal: failing,
      statePath: join(missing, "kill.json"),
      engine: { cancelAll: async () => (stops.push("turns"), [{ agent: "momentum", turnId: "t1" }]) },
      cards: { list: () => [], withdrawWhere: async () => (stops.push("cards"), []), refreshWhere: async () => (stops.push("sells"), []) },
    })
    const { k, published } = spare
    const first = await k.kill("v1")
    // The stops ran though nothing could be written, and the person is told the pause isn't saved.
    expect(stops).toEqual(["turns", "cards", "sells"])
    expect(k.paused()).toBe(true)
    expect(first.report.stopped.turns).toEqual([{ agent: "momentum", turnId: "t1" }])
    expect(first.report.unsaved).toBe(UNSAVED_WORDS)
    expect(published.at(-1)!.unsaved).toBe(UNSAVED_WORDS)
    expect(existsSync(join(missing, "kill.json"))).toBe(false)
    // The disk comes back: a second kill writes the file and the journal row, and the report stops saying so.
    mkdirSync(missing)
    diskFull = false
    const second = await k.kill("v1")
    expect(second.already).toBe(true)
    expect(second.report.unsaved).toBeUndefined()
    expect(JSON.parse(readFileSync(join(missing, "kill.json"), "utf8")).paused).toBe(true)
    expect(base.journal.rows().filter((r) => r.type === "kill.on")).toHaveLength(1)
    // A third kill writes neither again.
    await k.kill("v1")
    expect(base.journal.rows().filter((r) => r.type === "kill.on")).toHaveLength(1)
    // And the next core comes up paused.
    const next = await open([], undefined, { journal: base.journal, statePath: join(missing, "kill.json") })
    expect(next.k.paused()).toBe(true)
    for (const made of [base, spare, next]) {
      await made.journal.close()
      rmSync(made.dir, { recursive: true, force: true })
    }
  })

  test("what the pause held is said before it ends: resume journals it ahead of kill.off", async () => {
    let journalRef: Journal | undefined
    const { k, journal, dir } = await open([], undefined, {
      beforeResume: async () => {
        await journalRef!.append({ type: "bot.skipped", mode: "live", name: "conf", reason: "paused" })
      },
    })
    journalRef = journal
    await k.kill("v1")
    await k.resume("v1")
    const types = journal.rows().map((r) => r.type)
    expect(types.indexOf("bot.skipped")).toBeLessThan(types.indexOf("kill.off"))
    await journal.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("the report's in-flight line follows the operation until it settles", async () => {
    const { k, journal, dir, published } = await open([], undefined)
    const { report } = await k.kill("v1")
    expect(report.inFlight).toEqual([expect.objectContaining({ opId: "op1", state: "submitting" })])
    k.noteOperation({ opId: "op1", state: "succeeded" } as never)
    expect(k.current()!.inFlight[0]!.state).toBe("succeeded")
    expect(published.at(-1)!.inFlight[0]!.state).toBe("succeeded")
    k.noteOperation({ opId: "other", state: "failed" } as never) // not in the report: nothing published
    expect(published).toHaveLength(2)
    await journal.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("a lost swap whose read-back the kill switch holds is marked held in the report, and unmarked when it's read", async () => {
    const { k, journal, dir, published } = await open([], undefined)
    await k.kill("v1")
    k.noteOperation({ opId: "op1", state: "unknown", held: true } as never)
    expect(published.at(-1)!.inFlight[0]).toMatchObject({ state: "unknown", held: true })
    k.noteOperation({ opId: "op1", state: "unknown" } as never)
    expect(published.at(-1)!.inFlight[0]!.held).toBeUndefined()
    await journal.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
