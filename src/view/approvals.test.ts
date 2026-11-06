// The approvals menu: only the person turns a wallet on, by its figures and one click;
// Esc leaves it as it was; switching back to asking is at once; and every limit says who holds it.
import { describe, expect, test } from "bun:test"
import type { AutonomyTopic } from "../core/autonomy"
import type { LimitLine } from "../core/limits"
import { type AgentLimits, bindsFirst, dayCapsFirst, detailRows, limitRows, parseFigure, uncappedLines } from "./approvals"
import { type Effect, INITIAL_UI, type Key, SETTINGS, step, type UiAction, type UiContext, type UiState } from "./keys"
import { approvalsDetail, listRowSegs } from "./panes/approvals"
import { textOf } from "./panes/lines"

const EMBEDDED = "Emb111111111111111111111111111111111111111"
const TEE = "Tee111111111111111111111111111111111111111"

const AUTONOMY: AutonomyTopic = {
  read: true,
  wallets: [
    { wallet: EMBEDDED, name: "embedded", kind: "embedded", setting: "inside", perTradeUsd: 1.5, perDayUsd: 5, usedTodayUsd: 3, agents: ["agent-a", "agent-b"], notes: [] },
    { wallet: TEE, name: "tee-one", kind: "tee", setting: "ask", usedTodayUsd: 0, agents: ["agent-a"], notes: [] },
  ],
}

const lines = (agent: string, extra: LimitLine[]): LimitLine[] => [
  { by: "Harness", what: "trade", words: "Harness · $10.00 a trade" },
  { by: "Harness", what: "day", words: `Harness · $100.00 a day · ${agent === "agent-a" ? "$12.00" : "$0.00"} used` },
  { by: "Harness", what: "wallet-trade", wallet: EMBEDDED, words: "Harness · embedded without a card · $1.50 a trade" },
  ...extra,
]
const LIMITS: AgentLimits[] = [
  { name: "agent-a", limits: { perTradeUsd: 10, perDayUsd: 100 }, limitLines: lines("agent-a", [{ by: "Candle", what: "volume", words: "Candle · $50.00 a UTC day, all volume" }]) },
  { name: "agent-b", limits: { perTradeUsd: 10, perDayUsd: 100 }, limitLines: lines("agent-b", [{ by: "Candle", what: "none", words: "Candle · no cap on this key" }]) },
]

function ctx(over: Partial<UiContext> = {}): UiContext {
  return { cards: [], seenAt: {}, mode: "live", agents: ["agent-a", "agent-b"], activeAgent: "agent-a", commands: { agents: ["agent-a", "agent-b"], knownTokens: new Map() }, autonomy: AUTONOMY, limits: LIMITS, ...over }
}

function run(actions: UiAction[], c: UiContext = ctx(), start: UiState = INITIAL_UI): { state: UiState; effects: Effect[] } {
  let state = start
  const effects: Effect[] = []
  for (const a of actions) {
    const r = step(state, a, c)
    state = r.state
    effects.push(...r.effects)
  }
  return { state, effects }
}
const key = (name: string, extra: Partial<Key> = {}): UiAction => ({ type: "key", key: { name, sequence: name.length === 1 ? name : undefined, ...extra }, now: 0 })
const type = (text: string): UiAction[] => [...text].map((ch) => key(ch, { sequence: ch }))
const open: UiAction = { type: "pickSettings", index: SETTINGS.findIndex((r) => r.id === "approvals"), now: 0 }

describe("opening it", () => {
  test("settings ▾ has an approvals row, which opens the menu on the first wallet", () => {
    expect(run([{ type: "clickSettings", now: 0 }, open]).state.overlay).toEqual({ kind: "approvals", wallet: 0, side: "wallets", row: 0 })
  })

  test("the palette has a row for it", () => {
    const r = run([{ type: "clickPalette", now: 0 }, { type: "pickPalette", id: "approvals", now: 0 }])
    expect(r.state.overlay?.kind).toBe("approvals")
  })
})

describe("turning a wallet on: its figures, then one click", () => {
  const toTee = [open, key("down"), key("right"), key("return")]

  test("nothing goes to the core before the turn-on chip", () => {
    const r = run([...toTee, ...type("2"), key("return"), ...type("10"), key("return")])
    expect(r.effects).toEqual([])
    expect(r.state.overlay).toMatchObject({ kind: "approvals", wallet: 1, draft: { perTrade: 2, perDay: 10 }, row: 2 })
  })

  test("the turn-on chip sends the wallet and both figures", () => {
    const r = run([...toTee, ...type("$2"), key("return"), ...type("10.50"), key("return"), key("return")])
    expect(r.effects).toEqual([{ type: "autonomy", wallet: TEE, name: "tee-one", setting: "inside", perTradeUsd: 2, perDayUsd: 10.5 }])
    expect(r.state.overlay).toEqual({ kind: "approvals", wallet: 1, side: "detail", row: 0 })
  })

  test("a click on turn on, with a figure missing, asks for it and sends nothing", () => {
    const r = run([...toTee, ...type("2"), key("return"), key("escape"), { type: "pickApprovals", row: "confirm", now: 0 }])
    expect(r.effects).toEqual([])
    expect(r.state.message?.text).toContain("a day may be")
  })

  test("Esc stops typing, then leaves the wallet as it was", () => {
    const r = run([...toTee, ...type("2"), key("escape"), key("escape")])
    expect(r.effects).toEqual([])
    expect(r.state.overlay).toEqual({ kind: "approvals", wallet: 1, side: "detail", row: 0 })
    expect(r.state.message?.text).toBe("Left tee-one as it was.")
    expect(run([...toTee, key("escape"), key("escape"), key("escape")]).state.overlay).toBeUndefined()
  })

  test("a day under a trade, or a figure that isn't one, is refused in words and kept to fix", () => {
    const under = run([...toTee, ...type("5"), key("return"), ...type("2"), key("return")])
    expect(under.state.message).toMatchObject({ level: "error", text: "A day without a card can't be less than a trade: $2.00 is under $5.00." })
    expect(under.state.overlay).toMatchObject({ typing: "2" })
    const bad = run([...toTee, ...type("1.234"), key("return")])
    expect(bad.state.message?.text).toContain("isn't a dollar figure")
  })

  test("letters don't type into a figure, and nothing else closes the menu", () => {
    const r = run([...toTee, ...type("b1x")])
    expect(r.state.overlay).toMatchObject({ kind: "approvals", typing: "1" })
  })
})

describe("a wallet that trades inside limits", () => {
  const toEmbedded = [open, key("right")]

  test("ask every time goes at once: it's less access", () => {
    expect(run([...toEmbedded, key("return")]).effects).toEqual([{ type: "autonomy", wallet: EMBEDDED, name: "embedded", setting: "ask" }])
    expect(run([open, { type: "pickApprovals", row: "ask", now: 0 }]).effects).toEqual([{ type: "autonomy", wallet: EMBEDDED, name: "embedded", setting: "ask" }])
  })

  test("a digit on a figure's row types a new one, sent on ⏎ with the other figure as it is", () => {
    const r = run([...toEmbedded, key("down"), ...type("3"), key("return")])
    expect(r.effects).toEqual([{ type: "autonomy", wallet: EMBEDDED, name: "embedded", setting: "inside", perTradeUsd: 3, perDayUsd: 5 }])
    const day = run([...toEmbedded, key("down"), key("down"), key("return"), ...type("8"), key("return")])
    expect(day.effects).toEqual([{ type: "autonomy", wallet: EMBEDDED, name: "embedded", setting: "inside", perTradeUsd: 1.5, perDayUsd: 8 }])
  })

  test("a new trade figure over the day's is refused", () => {
    const r = run([...toEmbedded, key("down"), ...type("6"), key("return")])
    expect(r.effects).toEqual([])
    expect(r.state.message?.level).toBe("error")
  })
})

describe("rows and figures", () => {
  test("which rows act, by the setting", () => {
    expect(detailRows(AUTONOMY.wallets[0], undefined)).toEqual(["ask", "perTrade", "perDay"])
    expect(detailRows(AUTONOMY.wallets[1], undefined)).toEqual(["turnOn"])
    expect(detailRows(AUTONOMY.wallets[1], {})).toEqual(["perTrade", "perDay", "confirm", "cancel"])
    expect(detailRows({ ...AUTONOMY.wallets[1]!, gone: true }, undefined)).toEqual([])
    expect(detailRows({ ...AUTONOMY.wallets[0]!, gone: true }, undefined)).toEqual(["ask"])
  })

  test("a figure is $0.01 to $1,000,000, to the cent", () => {
    expect(parseFigure("$1,000.5")).toEqual({ ok: true, usd: 1000.5 })
    expect(parseFigure("0").ok).toBe(false)
    expect(parseFigure("1.001").ok).toBe(false)
    expect(parseFigure("2000000").ok).toBe(false)
    expect(parseFigure("").ok).toBe(false)
  })

  test("the table: each agent's own limits and Candle's caps, with who holds each; the wallets' figures are above it", () => {
    expect(limitRows(["agent-a", "agent-b"], LIMITS)).toEqual([
      { agent: "agent-a", limit: "$10.00 a trade", who: "Harness" },
      { agent: "agent-a", limit: "$100.00 a day", who: "Harness", used: "$12.00" },
      { agent: "agent-a", limit: "$50.00 a UTC day, all volume", who: "Candle" },
      { agent: "agent-b", limit: "$10.00 a trade", who: "Harness" },
      { agent: "agent-b", limit: "$100.00 a day", who: "Harness", used: "$0.00" },
      { agent: "agent-b", limit: "no cap on this key", who: "Candle", look: true },
    ])
    expect(uncappedLines(["agent-a", "agent-b"], LIMITS)).toEqual(["Candle doesn't cap agent-b's key. Only the Candle Harness's limits hold for it."])
  })

  test("which day stops a key first, the Candle Harness's or Candle's, in one line ($100 against $50)", () => {
    expect(dayCapsFirst(["agent-a", "agent-b"], LIMITS)).toEqual(["Candle's $50.00 a UTC day on agent-a's key is lower than the Candle Harness's $100.00, so Candle stops its buys first."])
    expect(dayCapsFirst(["agent-a"], LIMITS, () => 20)).toEqual(["The Candle Harness's $20.00 a day for agent-a is lower than Candle's $50.00 on its key, so the Candle Harness stops it first."])
    expect(dayCapsFirst(["agent-a"], LIMITS, () => 50)[0]).toStartWith("The Candle Harness's day and Candle's on agent-a's key are both $50.00;")
    // A cap over a week or the key's life isn't a day's, so nothing is compared.
    const weekly: AgentLimits[] = [{ ...LIMITS[0]!, limitLines: lines("agent-a", [{ by: "Candle", what: "volume", words: "Candle · $50.00 a week (from Monday, UTC), all volume" }]) }]
    expect(dayCapsFirst(["agent-a"], weekly)).toEqual([])
  })

  test("an agent's own limit under a figure binds first", () => {
    expect(bindsFirst(["agent-a"], LIMITS, 20, 50)).toEqual(["agent-a's own limit, $10.00 a trade, binds first."])
    expect(bindsFirst(["agent-a"], LIMITS, 5, 500)).toEqual(["agent-a's own limit, $100.00 a day, binds first."])
    expect(bindsFirst(["agent-a"], LIMITS, 5, 50)).toEqual([])
  })
})

describe("what it draws", () => {
  const text = (state: Partial<Parameters<typeof approvalsDetail>[0]["state"]>, wallet = 0, width = 80) =>
    approvalsDetail({ wallet: AUTONOMY.wallets[wallet], state: { kind: "approvals", wallet, side: "detail", row: 0, ...state }, limits: LIMITS, width, read: true }).map(textOf)

  test("a wallet inside limits: its setting, the other as a chip, its figures with who holds them, and the day's use", () => {
    const t = text({})
    expect(t).toContain("embedded · agent-a, agent-b")
    expect(t.some((l) => l.includes("✓ trades inside limits") && l.includes(" ask every time "))).toBe(true)
    expect(t.some((l) => l.includes("a trade") && l.includes(" $1.50 ") && l.includes("Harness · this core"))).toBe(true)
    expect(t.some((l) => l.includes(" $5.00 ") && l.includes("$3.00 used today"))).toBe(true)
    expect(t).toContain("limits on its agents, and who holds them")
    expect(t.some((l) => l.startsWith("agent-b") && l.includes("no cap on this key") && l.includes("Candle"))).toBe(true)
    expect(t).toContain("Candle doesn't cap agent-b's key. Only the Candle Harness's limits hold for it.")
    expect(t.join(" ")).toContain("loss limits and a circuit breaker")
  })

  test("turning one on: the amber line, the figure being typed, the turn-on chip, and what binds first", () => {
    const t = text({ draft: { perTrade: 20 }, row: 1, typing: "50" }, 1)
    expect(t).toContain("Turn on trading inside limits: type its figures, then one click.")
    expect(t.some((l) => l.includes("$50▏"))).toBe(true)
    expect(t.some((l) => l.includes(" turn on ") && l.includes(" cancel "))).toBe(true)
    expect(t).toContain("  agent-a's own limit, $10.00 a trade, binds first.")
  })

  test("the list's wallet rows say each one's setting, the picked one bright", () => {
    const o = { kind: "approvals" as const, wallet: 1, side: "wallets" as const, row: 0 }
    const row = (entry: number) => listRowSegs({ kind: "wallet", entry, wallet: AUTONOMY.wallets[entry]!, indent: false }, o, 40)
    expect(row(0).right.text.trim()).toBe("inside limits")
    expect(row(1).right.text.trim()).toBe("asks every time")
    expect(row(1).left[0]!.bold).toBe(true)
    expect(row(0).left[0]!.bold).toBeUndefined()
  })
})
