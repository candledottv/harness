// Autonomy per wallet: the setting, set only from a main view, kept
// 0600 across a restart, narrowed by the agent on a card checked again when it runs, and a proposal that
// would widen anything refused.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, testConfig, testHome, until } from "../../test/core-fixture"
import { connectTestClient } from "../../test/core-test-client"
import { PROTOCOL_VERSION } from "../shared/rpc"
import { ASK, Autonomy, AutonomyDesk, type AutonomyDeskDeps, type AutonomyTopic, dollars, parseSetting, type PayWallet, widens } from "./autonomy"
import { startCore } from "./core-main"
import type { Operation } from "./execute"
import type { Journal, JournalRow } from "./journal"
import { readViewToken } from "./tokens"
import type { FaceClient } from "./tool-face"

const T0 = new Date(2026, 9, 31, 12, 0, 0).getTime()
/** The fake Candle's embedded wallet (test/fake-candle-mcp.ts). */
const FAKE_WALLET = "WalletFake111111111111111111111111111111111"
const EMBEDDED = "EmbedFake11111111111111111111111111111111111"
const TEE = "TeeFakeA1111111111111111111111111111111111111"
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  cleanupHomes()
})
const stateFile = () => {
  const dir = mkdtempSync(join(tmpdir(), "chrn-autonomy-"))
  dirs.push(dir)
  return join(dir, "autonomy.json")
}

describe("the setting", () => {
  test("a figure is a positive dollar amount, to the cent; a day holds at least a trade", () => {
    expect(dollars(1)).toBe(1)
    expect(dollars("$1.50")).toBe(1.5)
    expect(dollars(" 2 ")).toBe(2)
    expect(dollars(0.004)).toBeUndefined()
    for (const bad of [0, -1, NaN, Infinity, "1e3", "one", "", null, 2_000_000]) expect(dollars(bad)).toBeUndefined()
    expect(parseSetting({ setting: "ask" })).toEqual({ ok: true, value: ASK })
    expect(parseSetting({ setting: "inside", perTradeUsd: 1, perDayUsd: "$5" })).toEqual({ ok: true, value: { setting: "inside", perTradeUsd: 1, perDayUsd: 5 } })
    expect(parseSetting({ setting: "inside", perTradeUsd: 0, perDayUsd: 5 })).toMatchObject({ ok: false })
    expect(parseSetting({ setting: "inside", perTradeUsd: 2, perDayUsd: 1 })).toMatchObject({ ok: false, message: expect.stringContaining("a day holds at least one trade") })
    expect(parseSetting({ setting: "always" })).toMatchObject({ ok: false })
  })

  test("what widens: turning it on, or raising either figure; asking again never widens", () => {
    const inside = (perTradeUsd: number, perDayUsd: number) => ({ setting: "inside" as const, perTradeUsd, perDayUsd })
    expect(widens(ASK, inside(1, 5))).toEqual(["it turns on trading without a card"])
    expect(widens(inside(1, 5), ASK)).toEqual([])
    expect(widens(inside(1, 5), inside(0.5, 5))).toEqual([])
    expect(widens(inside(1, 5), inside(2, 5))).toEqual(["it raises a trade from $1.00 to $2.00"])
    expect(widens(inside(1, 5), inside(0.5, 6))).toEqual(["it raises a day from $5.00 to $6.00"])
  })

  test("kept 0600 by address across a restart; a wallet never set asks; an entry that doesn't read is dropped, so it asks", async () => {
    const path = stateFile()
    const a = new Autonomy(path)
    expect(a.get(EMBEDDED)).toEqual(ASK)
    expect(await a.set(EMBEDDED, { setting: "inside", perTradeUsd: 1, perDayUsd: 5 }, "v1", T0, "embedded")).toEqual(ASK)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const b = new Autonomy(path)
    expect(b.get(EMBEDDED)).toEqual({ setting: "inside", perTradeUsd: 1, perDayUsd: 5 })
    expect(b.entry(EMBEDDED)).toMatchObject({ name: "embedded", by: "v1" })
    expect(b.get(TEE)).toEqual(ASK)
    // A hand edit that widens past what parses, or names no wallet, applies to nothing.
    writeFileSync(path, JSON.stringify({ wallets: [{ wallet: EMBEDDED, value: { setting: "inside", perTradeUsd: -5, perDayUsd: 5 }, at: "x", by: "v" }, { value: { setting: "inside", perTradeUsd: 1, perDayUsd: 5 } }] }))
    expect(new Autonomy(path).all()).toEqual([])
    writeFileSync(path, "not json")
    expect(new Autonomy(path).get(EMBEDDED)).toEqual(ASK)
  })
})

describe("the desk", () => {
  const rows: JournalRow[] = []
  const journal = { append: async (row: Record<string, unknown>) => (rows.push(row as JournalRow), row as JournalRow) } as unknown as Journal
  afterEach(() => void rows.splice(0))
  const AGENT: FaceClient = { clientId: "h1", role: "harness", agent: "agent-a" }
  function desk(over: Partial<AutonomyDeskDeps> = {}, list: PayWallet[] = [
    { address: EMBEDDED, name: "embedded", kind: "embedded", agents: ["agent-a", "agent-b"] },
    { address: TEE, name: "tee-one", kind: "tee", agents: ["agent-a"] },
  ]) {
    const proposed: Parameters<AutonomyDeskDeps["propose"]>[0][] = []
    const autonomy = new Autonomy(stateFile())
    let changes = 0
    const d = new AutonomyDesk({
      autonomy,
      journal,
      mode: () => "live",
      now: () => T0,
      wallets: () => ({ list, read: true }),
      usedToday: (w) => (w === EMBEDDED ? 2 : 0),
      agentLimits: (agent) => (agent === "agent-b" ? { perTradeUsd: 0.5, perDayUsd: 10 } : { perTradeUsd: 2, perDayUsd: 10 }),
      candleCaps: (agent) => agent !== "agent-b",
      propose: async (input) => {
        proposed.push(input)
        return { cardId: "card_1", opId: "op_1", state: "awaiting_approval" } as never
      },
      onChange: () => void changes++,
      ...over,
    })
    return { d, autonomy, proposed, changes: () => changes }
  }
  const op = (params: Record<string, unknown>): Operation => ({ opId: "op_1", cardId: "card_1", kind: "autonomy", tool: "harness_limits", agent: "agent-a", mode: "live", params, state: "submitting", startedAt: T0, cardExpiresAt: T0 + 600_000 })
  const code = async (p: Promise<unknown>) => p.then(() => "none", (e: { code?: string }) => e.code)

  test("the person sets a wallet from a main view, by address, \"embedded\" or label; journalled with the old and new", async () => {
    const { d, autonomy, changes } = desk()
    const set = await d.set({ clientId: "v1", popped: false }, { wallet: "embedded", setting: "inside", perTradeUsd: 1, perDayUsd: 5 })
    expect(set).toMatchObject({ wallet: EMBEDDED, name: "embedded", was: ASK, now: { setting: "inside", perTradeUsd: 1, perDayUsd: 5 } })
    expect(autonomy.get(EMBEDDED)).toMatchObject({ setting: "inside" })
    expect(rows.at(-1)).toMatchObject({ type: "autonomy.set", wallet: EMBEDDED, walletName: "embedded", from: ASK, to: { setting: "inside", perTradeUsd: 1, perDayUsd: 5 }, by: "v1", how: "view" })
    expect(changes()).toBe(1)
    await d.set({ clientId: "v1", popped: false }, { wallet: "TEE-ONE", setting: "inside", perTradeUsd: 1, perDayUsd: 1 })
    expect(autonomy.get(TEE)).toMatchObject({ setting: "inside", perDayUsd: 1 })
    // Raising it is the person's too.
    await d.set({ clientId: "v1", popped: false }, { wallet: EMBEDDED, setting: "inside", perTradeUsd: 3, perDayUsd: 20 })
    expect(autonomy.get(EMBEDDED)).toMatchObject({ perTradeUsd: 3 })
  })

  test("refused from a popped view, for a wallet no agent pays from, and for a figure that isn't a positive dollar amount", async () => {
    const { d, autonomy } = desk()
    expect(await code(d.set({ clientId: "v2", popped: true }, { wallet: "embedded", setting: "inside", perTradeUsd: 1, perDayUsd: 5 }))).toBe("MAIN_VIEW_ONLY")
    expect(await code(d.set({ clientId: "v1", popped: false }, { wallet: "elsewhere", setting: "inside", perTradeUsd: 1, perDayUsd: 5 }))).toBe("UNKNOWN_WALLET")
    for (const perTradeUsd of [0, -1, "lots"]) expect(await code(d.set({ clientId: "v1", popped: false }, { wallet: "embedded", setting: "inside", perTradeUsd, perDayUsd: 5 }))).toBe("INVALID_PARAMS")
    expect(autonomy.all()).toEqual([])
    expect(rows).toEqual([])
  })

  test("a wallet that's gone keeps its entry, shown as gone, and may only go back to asking", async () => {
    const path = stateFile()
    await new Autonomy(path).set("GoneFake111111111111111111111111111111111111", { setting: "inside", perTradeUsd: 1, perDayUsd: 5 }, "v1", T0, "old-tee")
    const { d } = desk({ autonomy: new Autonomy(path) })
    const gone = d.view().wallets.find((w) => w.name === "old-tee")
    expect(gone).toMatchObject({ gone: true, agents: [], setting: "inside" })
    // Nothing pays from it, so its figures apply to nothing; it's never turned on, or raised, unseen.
    expect(d.figures("agent-a").map((f) => f.name)).toEqual([])
    expect(d.inside().map((w) => w.name)).toEqual([])
    expect(await code(d.set({ clientId: "v1", popped: false }, { wallet: "GoneFake111111111111111111111111111111111111", setting: "inside", perTradeUsd: 2, perDayUsd: 5 }))).toBe("UNKNOWN_WALLET")
    expect((await d.set({ clientId: "v1", popped: false }, { wallet: "GoneFake111111111111111111111111111111111111", setting: "ask" })).now).toEqual(ASK)
  })

  test("the topic: each wallet's setting, today's use and who pays; an agent's own limit that binds first, and a key Candle doesn't cap", async () => {
    const { d } = desk()
    expect(d.view().wallets.map((w) => [w.name, w.setting, w.usedTodayUsd, w.agents])).toEqual([
      ["embedded", "ask", 2, ["agent-a", "agent-b"]],
      ["tee-one", "ask", 0, ["agent-a"]],
    ])
    await d.set({ clientId: "v1", popped: false }, { wallet: "embedded", setting: "inside", perTradeUsd: 1, perDayUsd: 5 })
    const embedded = d.view().wallets[0]!
    expect(embedded).toMatchObject({ perTradeUsd: 1, perDayUsd: 5, setAt: new Date(T0).toISOString() })
    expect(embedded.notes).toEqual([
      { kind: "binds-first", agent: "agent-b", words: "agent-b's own limit, $0.50 a trade, binds first." },
      { kind: "uncapped", agent: "agent-b", words: "Candle doesn't cap agent-b's key. Only the Candle Harness's limits hold here." },
    ])
    // The agent's limit lines carry each wallet it pays from that trades inside limits.
    expect(d.figures("agent-b")).toEqual([{ wallet: EMBEDDED, name: "embedded", perTradeUsd: 1, perDayUsd: 5, usedUsd: 2 }])
    expect(d.inside()).toEqual([{ wallet: EMBEDDED, name: "embedded" }])
  })

  test("before every wallet is read, a kept wallet isn't called gone", async () => {
    const path = stateFile()
    await new Autonomy(path).set(TEE, { setting: "inside", perTradeUsd: 1, perDayUsd: 5 }, "v1", T0, "tee-one")
    const { d } = desk({ autonomy: new Autonomy(path), wallets: () => ({ list: [], read: false }) })
    const view: AutonomyTopic = d.view()
    expect(view.read).toBe(false)
    expect(view.wallets[0]).not.toHaveProperty("gone")
  })

  test("the agent's narrowing is a one-press card; anything that widens is refused, naming the approvals menu, with nothing proposed", async () => {
    const { d, autonomy, proposed } = desk()
    // Turning it on, from asking: refused.
    const on = d.propose(AGENT, { wallet: "embedded", setting: "inside", perTradeUsd: 1, perDayUsd: 5 })
    await expect(on).rejects.toMatchObject({ code: "WIDENS_AUTONOMY" })
    await expect(on).rejects.toMatchObject({ message: expect.stringContaining("settings ▾ → approvals") })
    // Asking every time, already: nothing to change.
    expect(await code(d.propose(AGENT, { wallet: "embedded", setting: "ask" }))).toBe("ALREADY_SET")
    await autonomy.set(EMBEDDED, { setting: "inside", perTradeUsd: 1, perDayUsd: 5 }, "v1", T0, "embedded")
    // Raising either figure: refused.
    expect(await code(d.propose(AGENT, { wallet: "embedded", setting: "inside", perTradeUsd: 2, perDayUsd: 5 }))).toBe("WIDENS_AUTONOMY")
    expect(await code(d.propose(AGENT, { wallet: "embedded", setting: "inside", perDayUsd: 6 }))).toBe("WIDENS_AUTONOMY")
    // A wallet the agent doesn't pay from: refused, naming its own.
    expect(await code(d.propose({ ...AGENT, agent: "agent-b" }, { wallet: "tee-one", setting: "ask" }))).toBe("UNKNOWN_WALLET")
    expect(proposed).toEqual([])

    // Lower, one figure named: the other stays.
    await d.propose(AGENT, { wallet: "embedded", setting: "inside", perDayUsd: 2 }, "the person asked for less")
    expect(proposed[0]).toMatchObject({
      kind: "autonomy",
      tool: "harness_limits",
      agent: "agent-a",
      params: { wallet: EMBEDDED, name: "embedded", to: { setting: "inside", perTradeUsd: 1, perDayUsd: 2 } },
      title: "LESS AUTONOMY · embedded: $1.00 a trade, $2.00 a day without a card",
      warning: "agent-b also pays from it: this holds for them too.",
      reason: "the person asked for less",
    })
    await d.propose(AGENT, { wallet: "embedded", setting: "ask" })
    expect(proposed[1]).toMatchObject({ title: "LESS AUTONOMY · embedded: ask every time", params: { to: ASK } })
    // Nothing changed before the press.
    expect(autonomy.get(EMBEDDED)).toMatchObject({ setting: "inside", perDayUsd: 5 })
  })

  test("approved, it runs in the core, checked again: a wallet set lower since isn't widened back", async () => {
    const { d, autonomy } = desk()
    await autonomy.set(EMBEDDED, { setting: "inside", perTradeUsd: 1, perDayUsd: 5 }, "v1", T0, "embedded")
    const narrow = op({ wallet: EMBEDDED, name: "embedded", to: { setting: "inside", perTradeUsd: 1, perDayUsd: 2 } })
    expect(await d.run(narrow)).toMatchObject({ state: "succeeded", result: { done: true, now: "trades inside limits · $1.00 a trade, $2.00 a day without a card" } })
    expect(autonomy.get(EMBEDDED)).toMatchObject({ perDayUsd: 2 })
    expect(rows.at(-1)).toMatchObject({ type: "autonomy.set", by: "card", how: "card", agent: "agent-a", opId: "op_1", to: { perDayUsd: 2 } })
    expect(d.read(narrow)).toMatchObject({ state: "succeeded" })
    // The person sends it back to asking; an older card to $2 a day would now widen it.
    await autonomy.set(EMBEDDED, ASK, "v1", T0)
    expect(await d.run(narrow)).toMatchObject({ state: "refused", error: { code: "WIDENS_AUTONOMY" } })
    expect(autonomy.get(EMBEDDED)).toEqual(ASK)
    expect(d.read(narrow)).toMatchObject({ state: "failed", error: { code: "NOT_APPLIED" } })
  })
})

describe("in the core, end to end", () => {
  const cores: TestCore[] = []
  afterEach(async () => {
    for (const c of cores.splice(0)) await c.close().catch(() => {})
  })
  type Status = { agents: { name: string; limitLines: { by: string; what: string; words: string; wallet?: string }[] }[] }
  const lastOf = <T>(client: { events: { topic: string; data: unknown }[] }, topic: string) => [...client.events].reverse().find((e) => e.topic === topic)?.data as T | undefined

  test("only a main view sets it: a harness and a popped view are refused; it's published, joins the limit lines and is journalled", async () => {
    const c = await startTestCore()
    cores.push(c)
    const view = await c.view()
    await view.request("subscribe", { topics: ["autonomy", "status"] })
    await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.some((w) => w.wallet === FAKE_WALLET) === true)
    expect(lastOf<AutonomyTopic>(view, "autonomy")!.wallets.find((w) => w.wallet === FAKE_WALLET)).toMatchObject({ name: "embedded", kind: "embedded", setting: "ask", usedTodayUsd: 0, agents: ["momentum", "swing"] })

    const turnOn = { wallet: "embedded", setting: "inside", perTradeUsd: 1, perDayUsd: 5 }
    // The agent can't call it, and can't subscribe to the person's topic.
    const { client: harness } = await c.harness(view)
    expect((await harness.request("autonomy.set", turnOn)).error?.data).toMatchObject({ code: "FORBIDDEN_FOR_ROLE" })
    expect((await harness.request("subscribe", { topics: ["autonomy"] })).error).toBeDefined()
    // No tool reaches it: not harness_limits (which offers narrowing only), nor a card proposed by hand.
    for (const name of ["harness_limits", "autonomy.set", "autonomy"]) {
      const r = (await harness.request("tools.call", { name, args: turnOn })).result as { isError?: boolean } | undefined
      expect(r?.isError ?? true).toBe(true)
    }
    const byHand = await harness.request("cards.propose", { tool: "harness_limits", args: turnOn })
    if (!byHand.error) expect((byHand.result as { kind: string; display: { supported: boolean } })).toMatchObject({ kind: "unknown", display: { supported: false } })
    // A popped view, by its name or by the pane it holds.
    const named = await c.view("candle-harness view --pane wallets")
    expect((await named.request("autonomy.set", turnOn)).error?.data).toMatchObject({ code: "MAIN_VIEW_ONLY" })
    const holder = await c.view()
    await holder.request("view.pop", { pane: "positions" })
    expect((await holder.request("autonomy.set", turnOn)).error?.data).toMatchObject({ code: "MAIN_VIEW_ONLY" })
    expect(c.core.journal.rows().filter((r) => r.type === "autonomy.set")).toEqual([])
    expect(lastOf<AutonomyTopic>(view, "autonomy")!.wallets.every((w) => w.setting === "ask")).toBe(true)

    expect((await view.request("autonomy.set", turnOn)).result).toMatchObject({ wallet: FAKE_WALLET, name: "embedded", was: { setting: "ask" }, now: { setting: "inside", perTradeUsd: 1, perDayUsd: 5 } })
    await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.find((w) => w.wallet === FAKE_WALLET)?.setting === "inside")
    await until(() => lastOf<Status>(view, "status")?.agents[0]?.limitLines.some((l) => l.what === "wallet-day") === true)
    expect(lastOf<Status>(view, "status")!.agents[0]!.limitLines.filter((l) => l.wallet)).toEqual([
      { by: "Harness", what: "wallet-trade", wallet: FAKE_WALLET, words: "Harness · embedded without a card · $1.00 a trade" },
      { by: "Harness", what: "wallet-day", wallet: FAKE_WALLET, words: "Harness · embedded without a card · $5.00 a day · $0.00 used" },
    ])
    expect(c.core.journal.rows().filter((r) => r.type === "autonomy.set")).toMatchObject([{ wallet: FAKE_WALLET, how: "view", from: { setting: "ask" }, to: { setting: "inside" } }])
    expect(statSync(c.p.autonomyState).mode & 0o777).toBe(0o600)
  })

  test("the agent's narrowing card, approved with one press, takes; a restart keeps it", async () => {
    const c = await startTestCore()
    cores.push(c)
    const view = await c.view()
    await view.request("subscribe", { topics: ["autonomy", "cards", "operations"] })
    await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.some((w) => w.wallet === FAKE_WALLET) === true)
    await view.request("autonomy.set", { wallet: FAKE_WALLET, setting: "inside", perTradeUsd: 1, perDayUsd: 5 })

    const agent: FaceClient = { clientId: "harness-test", role: "harness", agent: "momentum" }
    await expect(c.core.autonomy.propose(agent, { wallet: "embedded", setting: "inside", perTradeUsd: 3, perDayUsd: 5 })).rejects.toMatchObject({ code: "WIDENS_AUTONOMY" })
    const card = await c.core.autonomy.propose(agent, { wallet: "embedded", setting: "ask" })
    expect(card).toMatchObject({ kind: "autonomy", state: "awaiting_approval" })
    const full = c.core.cards.get(card.cardId)!
    expect(full.display.title).toBe("LESS AUTONOMY · embedded: ask every time")
    // The kill switch leaves a narrowing alone: it's less access.
    await view.request("kill", {})
    expect(c.core.cards.get(card.cardId)!.state).toBe("awaiting_approval")
    expect((await view.request("cards.approve", { cardId: card.cardId, cardHash: full.cardHash, how: "enter" })).error).toBeUndefined()
    await until(() => c.core.cards.get(card.cardId)!.operation?.state === "succeeded")
    await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.find((w) => w.wallet === FAKE_WALLET)?.setting === "ask")
    expect(c.core.journal.rows().filter((r) => r.type === "autonomy.set").map((r) => [r.how, (r.to as { setting: string }).setting])).toEqual([["view", "inside"], ["card", "ask"]])

    // A restart keeps the setting: turned on again by the person, then the core restarted.
    await view.request("resume", {})
    await view.request("autonomy.set", { wallet: FAKE_WALLET, setting: "inside", perTradeUsd: 0.5, perDayUsd: 2 })
    const p = c.p
    cores.splice(0)
    await c.close()
    const again = await startCore({ paths: p, config: testConfig((await testHome()).candle), env: process.env, headless: true })
    try {
      await again.candleReady
      const client = await connectTestClient(p.socket)
      await client.request("core.hello", { protocol: PROTOCOL_VERSION, token: (await readViewToken(p.viewToken))!, clientName: "test" })
      await client.request("subscribe", { topics: ["autonomy"] })
      await until(() => lastOf<AutonomyTopic>(client, "autonomy")?.wallets.find((w) => w.wallet === FAKE_WALLET)?.setting === "inside")
      expect(lastOf<AutonomyTopic>(client, "autonomy")!.wallets.find((w) => w.wallet === FAKE_WALLET)).toMatchObject({ perTradeUsd: 0.5, perDayUsd: 2 })
      expect(JSON.parse(readFileSync(p.autonomyState, "utf8")).wallets).toHaveLength(1)
      client.close()
    } finally {
      await again.stop("test")
    }
  })

  test("the kill switch doesn't change it; its report names each wallet that trades inside limits, held by the pause", async () => {
    const c = await startTestCore()
    cores.push(c)
    const view = await c.view()
    await view.request("subscribe", { topics: ["autonomy"] })
    await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.some((w) => w.wallet === FAKE_WALLET) === true)
    const before = (await view.request("kill", {})).result as { report: { insideLimits?: unknown } }
    expect(before.report.insideLimits).toBeUndefined()
    await view.request("resume", {})
    await view.request("autonomy.set", { wallet: FAKE_WALLET, setting: "inside", perTradeUsd: 1, perDayUsd: 5 })
    const killed = (await view.request("kill", {})).result as { report: { insideLimits?: { wallet: string; name: string; words: string }[] } }
    expect(killed.report.insideLimits).toEqual([{ wallet: FAKE_WALLET, name: "embedded", words: "embedded wallet: trades inside limits, held by the pause. Its sells still go." }])
    await view.request("resume", {})
    expect(lastOf<AutonomyTopic>(view, "autonomy")!.wallets.find((w) => w.wallet === FAKE_WALLET)).toMatchObject({ setting: "inside", perTradeUsd: 1 })
  })
})
