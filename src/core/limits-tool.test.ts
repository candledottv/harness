// harness_limits: what the agent may do without asking, read from the core's own records, each limit naming
// who enforces it; a narrowing proposed as the autonomy's one-press card, never a widening; and the prompt's
// line ahead of a turn where a wallet trades inside limits.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { cleanupHomes, startTestCore, type TestCore, until } from "../../test/core-fixture"
import { scriptedEngine } from "../../test/scripted-engine"
import type { AutonomyTopic, AutonomyWallet } from "./autonomy"
import { toolAllowed, toolNameFault } from "../engine/tools"
import { autonomyNote, LIMITS_TOOL, limitsRead, narrowingArgs, narrows } from "./limits-tool"

const FAKE_WALLET = "WalletFake111111111111111111111111111111111"
const T0 = new Date(2026, 9, 31, 12, 0, 0).getTime()

const embedded = (o: Partial<AutonomyWallet> = {}): AutonomyWallet => ({ wallet: "E", name: "embedded", kind: "embedded", setting: "inside", perTradeUsd: 1.5, perDayUsd: 5, usedTodayUsd: 3, agents: ["momentum"], notes: [], ...o })
const tee = (o: Partial<AutonomyWallet> = {}): AutonomyWallet => ({ wallet: "T", name: "tee-one", kind: "tee", setting: "ask", usedTodayUsd: 0, agents: ["momentum"], notes: [], ...o })
const base = { agent: "momentum", mode: "live" as const, paused: false, lines: [], walletsRead: true, now: T0 }

describe("the read", () => {
  test("each wallet in words, then the agent's own limit, then what's always a card", () => {
    const body = limitsRead({ ...base, wallets: [embedded(), tee()], own: { perTradeUsd: 25, perDayUsd: 100, usedUsd: 4 } })
    expect(body.withoutCard).toEqual([
      "From the embedded wallet, a buy or swap worth up to $1.50 with Candle's fee runs at once with no card, while the day's buys and swaps without a card stay within $5.00 ($3.00 used, $2.00 left); over either, it's a card. Every sell from it runs without a card, whatever its size. A maxSlippageBps looser than the default makes any trade a card.",
      "From tee-one, every trade is a card.",
      "Your own Candle Harness limit, $25.00 a trade and $100.00 a day ($4.00 used), refuses anything over it, with a card or without.",
      "Everything else you propose (launches, stakes, claims, posts, key and wallet changes, Hacc's rules) is always a card.",
    ])
    expect(body.wallets).toEqual([
      { wallet: "embedded", setting: "trades inside limits", perTradeUsd: 1.5, perDayUsd: 5, usedTodayWithoutCardUsd: 3, leftTodayWithoutCardUsd: 2 },
      { wallet: "tee-one", setting: "asks every time" },
    ])
    expect(body.notListed).toContain("loss limits and a circuit breaker")
    expect(body.changing).toContain("settings ▾ → approvals")
  })

  test("paper mode, the pause, a held key and unread wallets come first; who else pays and the desk's notes ride along", () => {
    const body = limitsRead({
      ...base,
      mode: "paper",
      paused: true,
      hold: { agent: "momentum", until: T0 + 4 * 60_000, why: "stopped" },
      wallets: [embedded({ agents: ["momentum", "swing"], notes: [{ kind: "uncapped", agent: "momentum", words: "Candle doesn't cap momentum's key. Only the Candle Harness's limits hold here." }] })],
      lines: [{ by: "Candle", what: "none", words: "Candle · no cap on this key" }],
    })
    const words = body.withoutCard as string[]
    expect(words[0]).toStartWith("The Candle Harness is in paper mode")
    expect(words[1]).toStartWith("The kill switch is on")
    expect(words[2]).toBe("Candle stopped your key for a loss limit or its circuit breaker: every trade waits, sells included, and Candle is asked again in about 4 min. Only the account owner resumes it.")
    expect(body.wallets).toMatchObject([{ alsoPaysFromIt: ["swing"], notes: ["Candle doesn't cap momentum's key. Only the Candle Harness's limits hold here."] }])
    expect(body.limits).toEqual([{ by: "Candle", words: "Candle · no cap on this key" }])
    expect(limitsRead({ ...base, walletsRead: false, wallets: [] }).withoutCard).toContain("Your wallets aren't read yet, so until they are, every trade is a card.")
  })

  test("a read is any call without a setting or a figure; a figure alone narrows to lower figures", () => {
    expect(narrows({})).toBe(false)
    expect(narrows({ wallet: "embedded", reason: "x" })).toBe(false)
    expect(narrows({ perDayUsd: 2 })).toBe(true)
    expect(narrowingArgs({ wallet: "embedded", perDayUsd: 2, reason: "x" })).toEqual({ wallet: "embedded", perDayUsd: 2, setting: "inside" })
    expect(narrowingArgs({ wallet: "embedded", setting: "ask" })).toEqual({ wallet: "embedded", setting: "ask" })
    expect(LIMITS_TOOL.description).toContain("can't widen anything")
  })
})

describe("the prompt's line", () => {
  test("only in live mode, only where one of the agent's wallets trades inside limits", () => {
    expect(autonomyNote([tee()], "momentum", "live")).toBeUndefined()
    expect(autonomyNote([embedded()], "momentum", "paper")).toBeUndefined()
    expect(autonomyNote([embedded({ agents: ["swing"] })], "momentum", "live")).toBeUndefined()
    expect(autonomyNote([embedded({ gone: true })], "momentum", "live")).toBeUndefined()
    const line = autonomyNote([embedded(), tee()], "momentum", "live")!
    expect(line).toStartWith("Without a card (the person's setting): From the embedded wallet, a buy or swap worth up to $1.50")
    expect(line).toContain("From tee-one, every trade is a card.")
    expect(line).toContain('says so in "approved"')
    expect(line).toContain('its "why" names the figure')
    expect(line).toContain("Every sell from it runs without a card")
    expect(line.length).toBeLessThan(750)
  })
})

describe("in the core, end to end", () => {
  const cores: TestCore[] = []
  afterEach(async () => {
    for (const c of cores.splice(0)) await c.close().catch(() => {})
  })
  afterAll(cleanupHomes)
  const lastOf = <T>(client: { events: { topic: string; data: unknown }[] }, topic: string) => [...client.events].reverse().find((e) => e.topic === topic)?.data as T | undefined
  const answer = (r: { result?: unknown }) => JSON.parse((r.result as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>

  async function core(engines?: ReturnType<typeof scriptedEngine>[]) {
    const c = await startTestCore(engines ? { shim: ["/opt/candle-harness"], engine: { engines: engines.map((e) => e.engine), processes: () => [], leftoverDelayMs: 10 } } : {})
    cores.push(c)
    const view = await c.view()
    await view.request("subscribe", { topics: ["autonomy", "cards"] })
    await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.some((w) => w.wallet === FAKE_WALLET) === true)
    return { c, view }
  }

  test("offered to the agent; read, it says what runs without asking and who holds each limit", async () => {
    const { c, view } = await core()
    await view.request("autonomy.set", { wallet: "embedded", setting: "inside", perTradeUsd: 1.5, perDayUsd: 5 })
    const { client: harness } = await c.harness(view)
    const tools = (await harness.request("tools.list", {})).result as { tools: { name: string }[] }
    expect(tools.tools.map((t) => t.name)).toContain("harness_limits")
    const read = answer(await harness.request("tools.call", { name: "harness_limits", args: {} }))
    expect(read).toMatchObject({ success: true, agent: "momentum", wallets: [{ wallet: "embedded", setting: "trades inside limits", perTradeUsd: 1.5, perDayUsd: 5, usedTodayWithoutCardUsd: 0, alsoPaysFromIt: ["swing"] }] })
    expect((read.withoutCard as string[])[0]).toContain("up to $1.50 with Candle's fee runs at once with no card")
    expect((read.limits as { by: string; words: string }[]).map((l) => l.words)).toContain("Harness · embedded without a card · $1.50 a trade")
    // A read writes nothing.
    expect(c.core.journal.rows().filter((r) => r.type === "card.created" || r.type === "tool.refused")).toEqual([])
  })

  test("0.2's tui_* names: never listed, still taken on a call as the harness_* tool", async () => {
    const { c, view } = await core()
    const { client: harness } = await c.harness(view)
    const tools = (await harness.request("tools.list", {})).result as { tools: { name: string }[] }
    expect(tools.tools.some((t) => t.name.startsWith("tui_"))).toBe(false)
    const old = answer(await harness.request("tools.call", { name: "tui_limits", args: {} }))
    const now = answer(await harness.request("tools.call", { name: "harness_limits", args: {} }))
    expect(old).toMatchObject({ success: true, agent: "momentum" })
    expect(old.withoutCard).toEqual(now.withoutCard)
  })

  test("a 0.2 deny entry still hides the renamed tool, and a new one hides the old name", () => {
    expect(toolAllowed({ shell: "off", deny: ["tui_*"] }, "harness_limits")).toBe(false)
    expect(toolAllowed({ shell: "off", deny: ["tui_history"] }, "harness_history")).toBe(false)
    expect(toolAllowed({ shell: "off", deny: ["harness_limits"] }, "tui_limits")).toBe(false)
    expect(toolAllowed({ shell: "off", deny: [] }, "tui_limits")).toBe(true)
    expect(toolAllowed({ shell: "off", allow: ["tui_limits"], deny: [] }, "harness_limits")).toBe(true)
    expect(toolNameFault("tui_*")).toBeUndefined()
  })

  test("a narrowing is a one-press card that takes; a widening is refused and journalled; a resend under its id reads the card", async () => {
    const { c, view } = await core()
    await view.request("autonomy.set", { wallet: "embedded", setting: "inside", perTradeUsd: 1.5, perDayUsd: 5 })
    const { client: harness } = await c.harness(view)
    const wider = await harness.request("tools.call", { name: "harness_limits", args: { wallet: "embedded", perTradeUsd: 3 } })
    expect((wider.result as { isError?: boolean }).isError).toBe(true)
    expect(answer(wider)).toMatchObject({ error: { code: "WIDENS_AUTONOMY" } })
    expect(c.core.journal.rows().findLast((r) => r.type === "tool.refused")).toMatchObject({ tool: "harness_limits", code: "WIDENS_AUTONOMY", agent: "momentum" })

    const out = answer(await harness.request("tools.call", { name: "harness_limits", args: { wallet: "embedded", perDayUsd: 2, reason: "you asked me to keep it small" } }))
    expect(out).toMatchObject({ success: false, error: { code: "APPROVAL_REQUIRED" }, kind: "autonomy", state: "awaiting_approval" })
    const card = c.core.cards.get(out.cardId as string)!
    expect(card.display.title).toBe("LESS AUTONOMY · embedded: $1.50 a trade, $2.00 a day without a card")
    const again = answer(await harness.request("tools.call", { name: "harness_limits", args: { wallet: "embedded", perDayUsd: 2, coreOpId: out.coreOpId } }))
    expect(again.cardId).toBe(out.cardId)
    expect(c.core.cards.list().filter((k) => k.kind === "autonomy")).toHaveLength(1)

    await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })
    await until(() => lastOf<AutonomyTopic>(view, "autonomy")?.wallets.find((w) => w.wallet === FAKE_WALLET)?.perDayUsd === 2)
    const read = answer(await harness.request("tools.call", { name: "harness_limits", args: {} }))
    expect(read.wallets).toMatchObject([{ perTradeUsd: 1.5, perDayUsd: 2 }])
    const done = answer(await harness.request("tools.call", { name: "candle_get_operation", args: { clientId: out.coreOpId, kind: "autonomy" } }))
    expect(done).toMatchObject({ success: true, state: "succeeded" })
  })

  test("the prompt carries the line ahead of a live turn once a wallet trades inside limits, and not before", async () => {
    const engine = scriptedEngine("claude-code", [async (_t, push) => push({ type: "done", text: "ok" })])
    const { view } = await core([engine])
    await view.request("subscribe", { topics: ["agent"] })
    const ended = () => view.events.filter((e) => e.topic === "agent" && !e.snapshot && (e.data as { type?: string }).type === "ended").length
    await view.request("agent.send", { text: "first" })
    await until(() => ended() === 1)
    expect(engine.runs[0]!.prompt).not.toContain("Without a card")
    await view.request("autonomy.set", { wallet: "embedded", setting: "inside", perTradeUsd: 1.5, perDayUsd: 5 })
    await view.request("agent.send", { text: "second" })
    await until(() => ended() === 2)
    expect(engine.runs[1]!.prompt).toContain("Without a card (the person's setting): From the embedded wallet, a buy or swap worth up to $1.50")
    expect(engine.runs[1]!.systemPrompt).toContain("unless its wallet trades inside limits")
  })
})
