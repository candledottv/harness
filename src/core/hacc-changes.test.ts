// Hacc's changes: adds at once with an Activity line and
// an undo, removals and a rule's add on a one-press card with nothing sent before the press, Hacc's words for
// a refused definition and for its caps, replays polled in the core, and the kill switch leaving all of it.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { AGENT_KEY, cleanupHomes, startTestCore, type TestCore, until } from "../../test/core-fixture"
import { HACC_IN_PAPER } from "./cards"
import { type FakeHacc, startFakeHacc } from "../../test/fake-hacc"
import { activityLines } from "../view/panes/activity"
import { textOf } from "../view/panes/lines"
import type { Operation } from "./execute"
import { HaccClient } from "./hacc"
import { HaccChanges } from "./hacc-changes"
import type { Journal, JournalRow } from "./journal"
import type { HaccPlan } from "./plan-state"
import type { ActivityEntry } from "./trade-log"

const WALLET = "HaccFake1111111111111111111111111111111116H"
const OTHER = "HaccFake1111111111111111111111111111111117J"
const DEF = { chain: "solana", entry: { source: "pattern", pattern: "confluence", filters: { max_mcap_usd: 500000 } }, exit: { take_profit_pct: 100, stop_loss_pct: 40, max_hold_hours: 24 }, sizing: { usd_per_trade: 25, max_concurrent: 4 } }

let hacc: FakeHacc
beforeAll(() => {
  hacc = startFakeHacc({ keys: [AGENT_KEY] })
})
afterAll(() => {
  hacc.stop()
  cleanupHomes()
})
afterEach(() => {
  hacc.calls.length = 0
  hacc.state.follows.length = 0
  hacc.state.rules.length = 0
  hacc.state.groups.length = 0
  hacc.state.strategies.length = 0
  hacc.state.replays.clear()
  hacc.set({ fail: {}, slow: {}, plan: "max", replayPolls: 2, replayEnds: "done", replayQuota: 20 })
})

type Body = { success: boolean; error?: { code: string; message: string }; data?: any; cardId?: string; coreOpId?: string; title?: string; [k: string]: unknown }
const parse = (r: { content: { text: string }[]; isError?: boolean }) => JSON.parse(r.content[0]!.text) as Body
const sentChanges = () => hacc.calls.filter((c) => c.method !== "GET")

describe("in the core, end to end", () => {
  const cores: TestCore[] = []
  afterEach(async () => {
    for (const c of cores.splice(0)) await c.close().catch(() => {})
  })
  async function core() {
    const c = await startTestCore({ haccHost: hacc.url }, { config: { hacc: { enabled: true } }, candle: { momentum: { tier: "max" } } })
    cores.push(c)
    const view = await c.view()
    const { client: agent } = await c.harness(view, "momentum")
    const call = async (name: string, args: Record<string, unknown>) => parse((await agent.request("tools.call", { name, args })).result as { content: { text: string }[] })
    const approve = async (cardId: string) => {
      const card = c.core.cards.get(cardId)!
      const r = await view.request("cards.approve", { cardId, cardHash: card.cardHash, how: "enter" })
      if (r.error) throw new Error(JSON.stringify(r.error))
      await until(() => ["succeeded", "failed", "unknown"].includes(c.core.cards.get(cardId)!.operation?.state ?? ""))
      return c.core.cards.get(cardId)!
    }
    return { c, view, agent, call, approve }
  }

  test("adds run at once, with an Activity line and an undo that's the person's click", async () => {
    const { c, view, agent, call } = await core()
    expect((await view.request("subscribe", { topics: ["activity"] })).error).toBeUndefined()

    const followed = await call("hacc_follows", { view: "follow", address: WALLET })
    expect(followed).toMatchObject({ success: true, source: "hacc", view: "follow" })
    expect(followed.data.words).toContain("Max may follow 100: 1 followed")
    expect(hacc.state.follows.map((f) => f.address)).toEqual([WALLET])
    expect(hacc.calls.find((x) => x.method === "POST")).toMatchObject({ path: "/v1/me/follows", body: { chain: "solana", address: WALLET }, auth: `Bearer ${AGENT_KEY}` })
    const change = c.core.journal.rows().find((r) => r.type === "hacc.change")!
    expect(change).toMatchObject({ agent: "momentum", by: "agent", view: "follow", words: "followed Hacc…116H", undo: { method: "DELETE" } })
    expect(JSON.stringify(change)).not.toContain(AGENT_KEY)

    // A second follow of the same wallet changes nothing, and offers no undo that would unfollow it.
    const again = await call("hacc_follows", { view: "follow", address: WALLET })
    expect(again.data).toMatchObject({ already: true })
    expect(c.core.journal.rows().filter((r) => r.type === "hacc.change")).toHaveLength(1)

    const lineOf = () => view.events.filter((e) => e.topic === "activity").map((e) => (e.data as { entry?: ActivityEntry }).entry).filter((e): e is ActivityEntry => e !== undefined)
    await until(() => lineOf().some((e) => e.undo === change.changeId))
    const shown = activityLines(lineOf(), 60)
    expect(shown.some((l) => textOf(l).includes("momentum followed Hacc…116H on Hacc") && l.segs.some((s) => s.act === "undo") && l.ref === change.changeId)).toBe(true)

    // Only a view undoes; the agent can't.
    expect((await agent.request("hacc.undo", { changeId: change.changeId })).error).toBeDefined()
    const undone = await view.request("hacc.undo", { changeId: change.changeId })
    expect(undone.result).toMatchObject({ undone: true, text: "Undone on Hacc: unfollow Hacc…116H." })
    expect(hacc.state.follows).toHaveLength(0)
    expect((await view.request("hacc.undo", { changeId: change.changeId })).error).toMatchObject({ data: { code: "ALREADY_UNDONE" } })
    await until(() => lineOf().some((e) => e.undoes === change.changeId))
    // Its chip goes once a later line undid it.
    expect(activityLines(lineOf(), 60).some((l) => l.segs.some((s) => s.act === "undo"))).toBe(false)
    expect(lineOf().at(-1)!.text).toBe("undid momentum's change on Hacc: unfollow Hacc…116H")
  })

  test("a group made at once is undone only while it's empty; a strategy's undo retires it", async () => {
    const { c, view, call } = await core()
    const made = await call("hacc_follows", { view: "create_group", name: "early birds" })
    expect(made.data.words).toContain("Max may keep 5 groups: 1 kept")
    const id = Number(made.data.group.id)
    const added = await call("hacc_follows", { view: "group_add", id, address: WALLET })
    expect(added.data.words).toContain("1 of 25 wallets")
    const [groupChange, walletChange] = c.core.journal.rows().filter((r) => r.type === "hacc.change")
    expect((await view.request("hacc.undo", { changeId: groupChange!.changeId })).error).toMatchObject({ data: { code: "GROUP_NOT_EMPTY" } })
    expect(hacc.state.groups).toHaveLength(1)
    // Taking the wallet out goes by its wallet_id; then the group's own undo can go.
    await view.request("hacc.undo", { changeId: walletChange!.changeId })
    expect(hacc.calls.filter((x) => x.method === "DELETE").at(-1)!.path).toMatch(new RegExp(`^/v1/me/groups/${id}/wallets/\\d+$`))
    expect((await view.request("hacc.undo", { changeId: groupChange!.changeId })).result).toMatchObject({ undone: true })
    expect(hacc.state.groups).toHaveLength(0)

    const saved = await call("hacc_lab", { view: "save_strategy", name: "dip buy", definition: DEF })
    expect(saved.data.words).toContain("1 of Hacc's 20 saves a day")
    const strategy = hacc.state.strategies[0]!
    const v2 = await call("hacc_lab", { view: "save_version", id: strategy.id, definition: DEF })
    expect(v2.data.strategy).toMatchObject({ version: 2 })
    const saveChange = c.core.journal.rows().filter((r) => r.type === "hacc.change").find((r) => r.view === "save_strategy")!
    await view.request("hacc.undo", { changeId: saveChange.changeId })
    expect(hacc.state.strategies.find((s) => s.id === strategy.id)!.status).toBe("retired")
    expect(hacc.calls.at(-1)).toMatchObject({ method: "PATCH", body: { status: "retired" } })
  })

  test("each removal is a one-press card, and nothing is removed before the press", async () => {
    const { c, call, approve } = await core()
    await call("hacc_follows", { view: "follow", address: WALLET })
    const made = await call("hacc_follows", { view: "create_group", name: "g" })
    const gid = Number(made.data.group.id)
    await call("hacc_follows", { view: "group_add", id: gid, address: OTHER })
    await call("hacc_lab", { view: "save_strategy", name: "dip buy", definition: DEF })
    const sid = Number(hacc.state.strategies[0]!.id)
    const before = sentChanges().length

    const unfollow = await call("hacc_follows", { view: "unfollow", address: WALLET, reason: "it went quiet" })
    const takeOut = await call("hacc_follows", { view: "group_remove", id: gid, address: OTHER })
    const del = await call("hacc_follows", { view: "delete_group", id: gid })
    const retire = await call("hacc_lab", { view: "retire", id: sid })
    for (const r of [unfollow, takeOut, del, retire]) expect(r).toMatchObject({ success: false, error: { code: "APPROVAL_REQUIRED" }, kind: "hacc" })
    expect([unfollow.title, takeOut.title, del.title, retire.title]).toEqual(["Unfollow Hacc…116H", "Take Hacc…117J out of group 'g'", "Delete group 'g' (1 wallet)", "Retire strategy 'dip buy' v1"])
    // Nothing went to Hacc but reads.
    expect(sentChanges()).toHaveLength(before)
    expect(hacc.state.follows).toHaveLength(1)
    const card = c.core.cards.get(unfollow.cardId!)!
    expect(card).toMatchObject({ kind: "hacc", state: "awaiting_approval", wallet: "none", reason: "it went quiet" })
    expect(card.display).toMatchObject({ title: "Unfollow Hacc…116H", supported: true })
    expect(card.display.warning).toContain("another app may use this one")
    // The same ask while its card is open is that card.
    expect((await call("hacc_follows", { view: "unfollow", address: WALLET })).cardId).toBe(unfollow.cardId)

    for (const r of [unfollow, takeOut, del, retire]) expect((await approve(r.cardId!)).operation?.state).toBe("succeeded")
    expect(hacc.state.follows).toHaveLength(0)
    expect(hacc.state.groups).toHaveLength(0)
    expect(hacc.state.strategies[0]!.status).toBe("retired")
    // The agent reads the outcome as any card's.
    const read = await call("candle_get_operation", { clientId: unfollow.coreOpId, kind: "hacc" })
    expect(read).toMatchObject({ success: true, state: "succeeded" })
    // Nothing to remove answers so, with no card.
    expect(await call("hacc_follows", { view: "unfollow", address: WALLET })).toMatchObject({ error: { code: "HACC_NOT_FOUND" } })
  })

  test("a card that does a change's undo takes its chip away, and the click can't undo it again", async () => {
    const { c, view, call, approve } = await core()
    await view.request("subscribe", { topics: ["activity"] })
    await call("hacc_follows", { view: "follow", address: WALLET })
    await call("hacc_lab", { view: "save_strategy", name: "dip buy", definition: DEF })
    const [follow, save] = c.core.journal.rows().filter((r) => r.type === "hacc.change")
    const unfollow = await call("hacc_follows", { view: "unfollow", address: WALLET })
    const retire = await call("hacc_lab", { view: "retire", id: Number(hacc.state.strategies[0]!.id) })
    for (const r of [unfollow, retire]) expect((await approve(r.cardId!)).operation?.state).toBe("succeeded")
    const byCard = c.core.journal.rows().filter((r) => r.type === "hacc.change" && r.by === "card")
    expect(byCard.map((r) => r.undoOf)).toEqual([follow!.changeId, save!.changeId])
    expect((await view.request("hacc.undo", { changeId: follow!.changeId })).error).toMatchObject({ data: { code: "ALREADY_UNDONE" } })
    const lineOf = () => view.events.filter((e) => e.topic === "activity").map((e) => (e.data as { entry?: ActivityEntry }).entry).filter((e): e is ActivityEntry => e !== undefined)
    await until(() => lineOf().filter((e) => e.undoes).length === 2)
    const shown = activityLines(lineOf(), 80)
    expect(shown.some((l) => l.segs.some((s) => s.act === "undo"))).toBe(false)
    // The card's own line says what happened; the hidden one only takes the chip away.
    expect(shown.filter((l) => textOf(l).includes("undid"))).toHaveLength(0)
  })

  test("a rule's add is the card, saying it can't be removed; nothing is added before the press", async () => {
    const { c, call, approve } = await core()
    const asked = await call("hacc_follows", { view: "add_rule", name: "big", pattern: "large_move", min_usd: 5000 })
    expect(asked).toMatchObject({ error: { code: "APPROVAL_REQUIRED" }, title: "Add rule 'big' (large_move, $5,000)" })
    expect(c.core.cards.get(asked.cardId!)!.display.warning).toBe("Can't be removed on Hacc · 0 of 20 used, so this makes 1.")
    expect(c.core.cards.get(asked.cardId!)!.display).toMatchObject({ mode: "live" })
    expect(c.core.cards.get(asked.cardId!)!.display.modeNote).toBeUndefined()
    expect(hacc.state.rules).toHaveLength(0)
    expect((await approve(asked.cardId!)).operation).toMatchObject({ state: "succeeded", result: { rule: { name: "big", pattern: "large_move", params: { min_usd: 5000 } } } })
    expect(hacc.calls.find((x) => x.method === "POST")!.body).toEqual({ name: "big", pattern: "large_move", params: { min_usd: 5000 } })

    // Checked before anything is read or sent.
    expect(await call("hacc_follows", { view: "add_rule", name: "x", pattern: "large_move", days: 3, min_usd: 1 })).toMatchObject({ error: { code: "INVALID_ARGS", message: "large_move takes min_usd; it doesn't take days." } })
    expect(await call("hacc_follows", { view: "add_rule", name: "x", pattern: "confluence", wallets: 1 })).toMatchObject({ error: { code: "INVALID_ARGS", message: "wallets is at least 2." } })
    expect(await call("hacc_follows", { view: "add_rule", name: "x", pattern: "dormancy" })).toMatchObject({ error: { code: "INVALID_ARGS", message: "dormancy needs days." } })
    expect(await call("hacc_follows", { view: "add_rule", name: "x", pattern: "new_ticker", wallet_id: 4242 })).toMatchObject({ error: { code: "INVALID_ARGS" } })

    // At 20, no card: none can be removed.
    for (let i = 0; i < 19; i++) hacc.state.rules.push({ id: 1000 + i, name: `r${i}`, pattern: "distribution", params: {} })
    expect(await call("hacc_follows", { view: "add_rule", name: "one more", pattern: "distribution" })).toMatchObject({
      error: { code: "HACC_LIMIT", message: "Hacc allows 20 alert rules, and this account has 20. None can be removed on Hacc, so no more can be added." },
    })
  })

  test("in paper mode a Hacc card says it's real on Hacc, not paper, and approving it changes Hacc", async () => {
    const c = await startTestCore({ haccHost: hacc.url }, { config: { hacc: { enabled: true }, mode: "paper" }, candle: { momentum: { tier: "max" } } })
    cores.push(c)
    const view = await c.view()
    const { client: agent } = await c.harness(view, "momentum")
    const asked = parse((await agent.request("tools.call", { name: "hacc_follows", args: { view: "add_rule", name: "big", pattern: "large_move", min_usd: 5000 } })).result as { content: { text: string }[] })
    const card = c.core.cards.get(asked.cardId!)!
    expect(card.display).toMatchObject({ mode: "paper", modeNote: HACC_IN_PAPER })
    expect((await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })).error).toBeUndefined()
    await until(() => hacc.state.rules.length === 1)
  })

  test("a removal Hacc didn't answer is read back, never sent again", async () => {
    const { c, view, call, approve } = await core()
    await call("hacc_follows", { view: "follow", address: WALLET })
    const asked = await call("hacc_follows", { view: "unfollow", address: WALLET })
    hacc.set({ fail: { "DELETE /v1/me/follows/:id": { status: 500, body: { error: "internal error" } } } })
    const card = await approve(asked.cardId!)
    expect(card.operation).toMatchObject({ state: "unknown" })
    const resend = await view.request("operations.resolve", { opId: card.opId, action: "resend" })
    expect(resend.error).toMatchObject({ data: { code: "NO_RESEND" } })
    expect(hacc.calls.filter((x) => x.method === "DELETE")).toHaveLength(1)
    await until(() => c.core.journal.rows().some((r) => r.type === "operation.check" && r.opId === card.opId))
  })

  test("paused: Hacc's changes still run, and the kill switch neither withdraws nor lists their cards", async () => {
    const { c, view, call } = await core()
    await view.request("kill", {})
    expect((await call("hacc_follows", { view: "follow", address: WALLET })).success).toBe(true)
    const card = await call("hacc_follows", { view: "add_rule", name: "big", pattern: "large_move", min_usd: 5000 })
    expect(card.error?.code).toBe("APPROVAL_REQUIRED")
    const killed = (await view.request("kill", {})).result as { report: { stillOpen: { cardId: string }[]; stopped: { cards: unknown[] } } }
    expect(c.core.cards.get(card.cardId!)!.state).toBe("awaiting_approval")
    expect(killed.report.stillOpen.some((x) => x.cardId === card.cardId)).toBe(false)
    expect(JSON.stringify(killed.report.stopped.cards)).not.toContain(card.cardId!)
  })
})

describe("HaccChanges alone", () => {
  let clock = Date.parse("2026-10-29T12:00:00Z")
  function changes(o: { plan?: HaccPlan; waitMs?: number } = {}) {
    const rows: JournalRow[] = []
    const journal = {
      append: async (input: Record<string, unknown>) => {
        const row = { seq: rows.length + 1, at: new Date(clock).toISOString(), ...input } as JournalRow
        rows.push(row)
        return row
      },
      rows: () => rows,
    } as unknown as Journal
    const proposed: Record<string, unknown>[] = []
    const now = () => clock
    const h = new HaccChanges({
      hacc: new HaccClient({ keyFor: () => AGENT_KEY, host: hacc.url, now }),
      cards: { propose: async (input) => (proposed.push(input), { cardId: "card_1", opId: "op_1", idKey: "coreOpId", kind: "hacc", tool: input.tool, asked: input.args, agent: input.agent, state: "awaiting_approval", expiresAt: "x" }) },
      journal,
      mode: () => "live",
      now,
      plan: () => o.plan ?? "max",
      // Each wait moves the clock, so the replay's 45 s pass in no time.
      sleep: async (ms) => {
        clock += ms
        await Bun.sleep(1)
      },
      ...(o.waitMs !== undefined ? { replayWaitMs: o.waitMs } : {}),
    })
    const client = { clientId: "c1", role: "harness" as const, agent: "momentum" }
    const call = async (tool: string, view: string, args: Record<string, unknown>) => parse(await h.call(client, tool, view, args))
    return { h, rows, proposed, call }
  }

  test("a definition Hacc refuses answers with Hacc's own path and message", async () => {
    const { call, rows } = changes()
    const r = await call("hacc_lab", "save_strategy", { name: "x", definition: { ...DEF, extra: true } })
    expect(r.error).toMatchObject({ code: "HACC_BAD_REQUEST" })
    expect(r.error!.message).toContain("Unrecognized key(s) in object: 'extra'")
    expect(r.error!.message).toContain("Fix that one and save again")
    expect(rows).toHaveLength(0)
  })

  test("a replay is waited for and answered done, with its verdict, and Activity is told", async () => {
    const { call, rows } = changes()
    const r = await call("hacc_lab", "run_replay", { definition: DEF, from: "2026-10-27T00:00:00Z", to: "2026-10-29T00:00:00Z", asset_ids: "1, 2" })
    expect(r).toMatchObject({ success: true, view: "run_replay", data: { status: "done", quota: "1 of Hacc's 20 replays a day from this Candle Harness today" } })
    expect(r.leftOut).toContain("a model of the past")
    expect(hacc.calls.find((x) => x.method === "POST")!.body).toMatchObject({ asset_ids: [1, 2] })
    expect(rows.map((x) => x.type)).toEqual(["hacc.change", "hacc.replay"])
    // Hacc sends pnl_usd as a decimal string: the journal keeps it as a number.
    expect(rows[1]).toMatchObject({ status: "done", verdict: "fail", trades: 22, pnlUsd: -20.4454236189, drawdownPct: 83.99690371372242 })
  })

  test("a replay still running after the wait answers with its job id, and the core polls on until it ends", async () => {
    hacc.set({ replayPolls: 30 })
    const { call, rows, h } = changes({ waitMs: 9_000 })
    const r = await call("hacc_lab", "run_replay", { definition: DEF, from: "2026-10-27T00:00:00Z", to: "2026-10-29T00:00:00Z" })
    expect(r.data).toMatchObject({ status: "running" })
    expect(r.data.words).toContain(`read it then with view replay, id ${r.data.job_id}`)
    expect(r.data.words).toContain("Don't wait for it in this turn")
    // A second replay while it runs: Hacc's 409, in words.
    const busy = await call("hacc_lab", "run_replay", { definition: DEF, from: "2026-10-27T00:00:00Z", to: "2026-10-29T00:00:00Z" })
    expect(busy.error).toMatchObject({ code: "HACC_BUSY" })
    expect(busy.error!.message).toContain(`job ${r.data.job_id} is running`)
    expect(busy.jobId).toBe(r.data.job_id)
    await until(() => rows.some((x) => x.type === "hacc.replay"), 5000)
    expect(rows.find((x) => x.type === "hacc.replay")).toMatchObject({ jobId: r.data.job_id, status: "done" })
    h.stop()
  })

  test("the caps and quotas in words", async () => {
    const { call } = changes({ plan: "pro" })
    hacc.set({ plan: "pro" })
    for (let i = 0; i < 25; i++) hacc.state.follows.push({ id: 5000 + i, address: `HaccFake${String(i).padStart(35, "1")}`, chain: "solana" })
    const full = await call("hacc_follows", "follow", { address: WALLET })
    expect(full.error).toMatchObject({ code: "HACC_LIMIT" })
    expect(full.error!.message).toContain("Pro may follow 25: 25 followed. An unfollow, which the person approves on a card, makes room.")

    hacc.set({ plan: "max", replayQuota: 0 })
    const replays = await call("hacc_lab", "run_replay", { definition: DEF, from: "2026-10-27T00:00:00Z", to: "2026-10-29T00:00:00Z" })
    expect(replays.error).toMatchObject({ code: "HACC_LIMIT" })
    expect(replays.error!.message).toContain("20 replays a day: 0 used")
  })

  test("a removal nobody saw end is read back from Hacc's state", async () => {
    const { h } = changes()
    hacc.state.follows.push({ id: 77, address: WALLET, chain: "solana" })
    const op = { opId: "op", cardId: "card", kind: "hacc", tool: "hacc_follows", agent: "momentum", mode: "live", params: { method: "DELETE", route: "/v1/me/follows/77", view: "unfollow" }, state: "unknown", startedAt: clock, cardExpiresAt: 0 } as unknown as Operation
    // Still there, and too soon to say: read again later.
    expect(await h.readBack(op)).toBeUndefined()
    clock += 31_000
    expect(await h.readBack(op)).toMatchObject({ state: "failed", error: { code: "HACC_NOT_CHANGED" } })
    hacc.state.follows.length = 0
    expect(await h.readBack(op)).toMatchObject({ state: "succeeded" })
    // A rule's add, read back by its name, pattern and params.
    const rule = { ...op, params: { method: "POST", route: "/v1/me/rules", body: { name: "big", pattern: "large_move", params: { min_usd: 5000 } }, view: "add_rule" }, startedAt: clock } as unknown as Operation
    expect(await h.readBack(rule)).toBeUndefined()
    hacc.state.rules.push({ id: 9, name: "big", pattern: "large_move", params: { min_usd: 5000 }, created_at: new Date(clock).toISOString() })
    expect(await h.readBack(rule)).toMatchObject({ state: "succeeded" })
  })

  test("undos are rebuilt from the journal after a restart", async () => {
    const first = changes()
    await first.call("hacc_follows", "follow", { address: WALLET })
    const second = changes()
    second.h.rebuild(first.rows)
    const changeId = String(first.rows[0]!.changeId)
    expect(await second.h.undo("view", changeId)).toMatchObject({ undone: true })
    expect(hacc.state.follows).toHaveLength(0)
  })
})
