// A code bot's own report: kept beside the core's count, never its figures; each field replaces, events add once;
// its text cleaned to one line; anything over its size refused whole, by name.
import { expect, test } from "bun:test"
import { BotReports, REPORT_LIMITS } from "./bot-report"

const T0 = Date.parse("2026-11-08T12:00:00Z")
const MOON = "MoonFake11111111111111111111111111111111111"
const code = (f: () => unknown) => {
  try {
    f()
  } catch (e) {
    return (e as { data?: { code?: string } }).data?.code ?? (e as { code?: string }).code
  }
  return "kept"
}

test("a report is kept, each field it sends replaces that field, and one it leaves out keeps what it said", () => {
  let now = T0
  const r = new BotReports(() => now)
  r.take("b", { status: "watching 14 tokens", health: "ok", rules: ["Buys $2 on a fresh launch"], counts: { watching: 14 } })
  now += 5_000
  r.take("b", { health: "warn", alerts: [{ code: "quotes", text: "quotes failing on 2 tokens" }, "spread above 8%"] })
  expect(r.view("b")).toEqual({
    at: new Date(T0 + 5_000).toISOString(),
    status: "watching 14 tokens",
    health: "warn",
    alerts: [{ code: "quotes", text: "quotes failing on 2 tokens" }, { text: "spread above 8%" }],
    rules: ["Buys $2 on a fresh launch"],
    counts: [{ name: "watching", value: 14 }],
    events: [],
    controls: [],
  })
  // An empty list clears alerts: it's what the bot says now.
  r.take("b", { alerts: [] })
  expect(r.view("b")!.alerts).toEqual([])
  expect(r.view("other")).toBeUndefined()
})

test("events are added newest first, an id sent again is kept once, and only the newest are kept", () => {
  let now = T0
  const r = new BotReports(() => now)
  expect(r.take("b", { events: [{ id: "e1", kind: "considered", text: "MOON on the tape", mint: MOON, at: T0 / 1000 - 60 }, { kind: "skipped", text: "MOON: spread too wide" }] })).toMatchObject({ events: 2 })
  // Sent again after a reconnect: nothing twice.
  expect(r.take("b", { events: [{ id: "e1", kind: "considered", text: "MOON on the tape" }] })).toMatchObject({ events: 0 })
  expect(r.events("b").map((e) => [e.kind, e.at])).toEqual([
    ["skipped", new Date(T0).toISOString()],
    ["considered", new Date(T0 - 60_000).toISOString()],
  ])
  for (let i = 0; i < 3; i++) {
    now += 1_000
    r.take("b", { events: Array.from({ length: 50 }, (_, j) => ({ id: `x${i}-${j}`, kind: "note", text: `note ${i}-${j}` })) })
  }
  expect(r.events("b")).toHaveLength(REPORT_LIMITS.eventsKept)
  expect(r.view("b")!.events).toHaveLength(REPORT_LIMITS.eventsShown)
})

test("its P&L, positions, fills and balances are never its report's: refused, and nothing of the report kept", () => {
  const r = new BotReports(() => T0)
  for (const k of ["pnl", "realized", "unrealized", "positions", "fills", "balance", "value", "costUsd", "wallets", "trades"]) {
    expect(code(() => r.take("b", { status: "fine", [k]: 1 }))).toBe("REPORT_FIGURES")
  }
  expect(code(() => r.take("b", { counts: { pnl: 3.2 } }))).toBe("REPORT_FIGURES")
  expect(r.view("b")).toBeUndefined()
})

test("a count named as one of the core's figures is refused however it's spelt; a bot's own counts, a loss among their words, are kept", () => {
  const r = new BotReports(() => T0)
  for (const name of ["PnL", "P&L today", "p_n_l", "Balance", "Realized", "realised so far", "Unrealised", "profit", "Loss", "ROI", "equity", "Cost USD", "Positions", "FILLS", "open pnl"]) {
    expect(code(() => r.take("b", { status: "fine", counts: { [name]: 1 } }))).toBe("REPORT_FIGURES")
  }
  expect(r.view("b")).toBeUndefined()
  r.take("b", { status: "P&L +$40 today", counts: { watching: 14, "quotes failing": 2, "stop loss hits": 3, "trades skipped": 5, valued: 1 } })
  expect(r.view("b")!.counts.map((c) => c.name)).toEqual(["watching", "quotes failing", "stop loss hits", "trades skipped", "valued"])
  // Its status is its own words, shown as the bot's: left as it wrote it.
  expect(r.view("b")!.status).toBe("P&L +$40 today")
})

test("checked whole: one field that doesn't fit refuses all of it, by name", () => {
  const r = new BotReports(() => T0)
  r.take("b", { status: "before" })
  const cases: Record<string, unknown>[] = [
    { status: "after", health: "fine" },
    { status: "x".repeat(REPORT_LIMITS.status + 1) },
    { status: "after", alerts: Array.from({ length: REPORT_LIMITS.alerts + 1 }, () => "a") },
    { status: "after", rules: ["ok", 3] },
    { status: "after", counts: { watching: "14" } },
    { status: "after", events: [{ kind: "bought", text: "x" }] },
    { status: "after", events: [{ kind: "note", text: "x", mint: "not-a-mint" }] },
    { status: "after", events: [{ kind: "note", text: "x", at: (T0 + 10 * 60_000) / 1000 }] },
    { status: "after", events: Array.from({ length: REPORT_LIMITS.eventsPerReport + 1 }, () => ({ kind: "note", text: "x" })) },
    { status: "after", mood: "happy" },
    { status: "after", events: [{ kind: "note", text: "x", extra: 1 }] },
  ]
  for (const c of cases) expect(code(() => r.take("b", c))).toBe("INVALID_PARAMS")
  expect(r.view("b")!.status).toBe("before")
})

test("its text is cleaned as any outside text, and kept to one line", () => {
  const r = new BotReports(() => T0)
  r.take("b", { status: "watching\u001b[2J  MO\u200bON\nand\u202eWIF", events: [{ kind: "note", text: "\u0007 line one\r\nline two " }] })
  expect(r.view("b")!.status).toBe("watching[2J MOON andWIF")
  expect(r.view("b")!.events[0]!.text).toBe("line one line two")
  // Nothing left once cleaned is refused rather than kept blank.
  expect(code(() => r.take("b", { status: "\u200b\u0007" }))).toBe("INVALID_PARAMS")
})

test("a bot removed takes what it said with it", () => {
  const r = new BotReports(() => T0)
  r.take("a", { status: "on" })
  r.take("b", { status: "on" })
  r.forgetExcept(new Set(["a"]))
  expect(r.view("a")).toBeDefined()
  expect(r.view("b")).toBeUndefined()
})

test("a bot's controls are suggestions it offers, checked whole: pause, or some of its card's figures set", () => {
  const r = new BotReports(() => T0)
  r.take("b", { controls: [{ id: "calm", label: "Calm down: $1 a trade", set: { perTradeUsd: 1, maxOpen: 1 } }, { id: "hold", label: "Pause me", pause: true }] })
  expect(r.view("b")!.controls).toEqual([
    { id: "calm", label: "Calm down: $1 a trade", set: { perTradeUsd: 1, maxOpen: 1 } },
    { id: "hold", label: "Pause me", pause: true },
  ])
  expect(r.control("b", "hold")).toEqual({ id: "hold", label: "Pause me", pause: true })
  expect(r.control("b", "nope")).toBeUndefined()
  // A report without controls keeps them; an empty list clears them.
  r.take("b", { status: "fine" })
  expect(r.view("b")!.controls).toHaveLength(2)
  const refusedWith = (controls: unknown) => {
    try {
      r.take("b", { controls })
      return undefined
    } catch (e) {
      return (e as { message: string }).message
    }
  }
  expect(refusedWith([{ id: "x", label: "both", pause: true, set: { perTradeUsd: 1 } }])).toContain("takes pause: true, or set")
  expect(refusedWith([{ id: "x", label: "neither" }])).toContain("takes pause: true, or set")
  expect(refusedWith([{ id: "x", label: "go live", set: { mode: "live" } }])).toContain("controls[0].set.mode isn't part of a report")
  expect(refusedWith([{ id: "x", label: "wallet", set: { wallet: "embedded" } }])).toContain("controls[0].set.wallet isn't part of a report")
  expect(refusedWith([{ id: "x", label: "zero", set: { perDayUsd: 0 } }])).toContain("a number above 0")
  expect(refusedWith([{ id: "x", label: "half", set: { maxOpen: 1.5 } }])).toContain("a whole number")
  expect(refusedWith([{ id: "x", label: "a", pause: true }, { id: "x", label: "b", pause: true }])).toContain("used twice")
  expect(refusedWith(Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, label: "p", pause: true })))).toContain("over its 4")
  expect(refusedWith([{ id: "x", label: "y".repeat(41), pause: true }])).toContain("over its 40")
  // None of those refusals kept anything.
  expect(r.view("b")!.controls.map((c) => c.id)).toEqual(["calm", "hold"])
  r.take("b", { controls: [] })
  expect(r.view("b")!.controls).toEqual([])
})
