// Triggers on screen, kept as frames: the Triggers overlay (the list and the picked trigger, narrow its trigger
// opened, and the plan's words on Free), a trigger's card when the agent proposes it (how it runs in a box of its
// own), a firing as one line in the agent pane and in Activity, a trigger's card waiting for the person, and the
// status bar's chip. As frames.test.tsx keeps the Trade tab's.
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { act } from "react"
import type { ActivityEntry } from "../core/trade-log"
import type { TriggersTopic, TriggerView } from "../core/triggers"
import { CLOCK, drawScene, EMBEDDED, MINT, status } from "../../test/frame-scenes"
import type { ViewCard } from "./store"
import { triggersPaneLines } from "./triggers-view"

process.env.TZ = "UTC"
const DIR = join(import.meta.dir, "../../test/fixtures/frames")
const UPDATE = process.env.UPDATE_FRAMES === "1"

type Setup = Awaited<ReturnType<typeof drawScene>>["setup"]
let setup: Setup | undefined
afterEach(async () => {
  const s = setup
  setup = undefined
  if (s) await act(async () => s.dispose())
})

const SIZES = [
  [160, 45],
  [120, 30],
  [80, 24],
] as const

const at = (ms: number) => new Date(CLOCK - ms).toISOString()
const view = (over: Partial<TriggerView> & Pick<TriggerView, "name" | "line" | "words">): TriggerView => ({ agent: "agent-a", expansion: over.line, class: "level", on: true, live: true, mode: "live", again: false, armed: true, ...over })
const ASKS = "Asks you each time: the embedded wallet asks every time, so each firing is a card for you to approve or reject within 60 s."
const TOPIC: TriggersTopic = {
  problems: [],
  triggers: [
    view({ name: "jupf stop", line: "when JUPF < $0.40 sell 50% of JUPF", words: "When JUPF's price falls below $0.40, sell 50% of JUPF. Fires once, then switches off.", paysFrom: "embedded", runs: { runs: "asks", words: ASKS }, watching: "checked about every 5 s · JUPF $0.4249", paceMs: 5000, fills: [{ label: "new TEE wallet for agent-a", line: "candle vault promote --to-key ABCDEFGH --label agent-a-tee --from " }] }),
    view({ name: "morning buy", class: "schedule", line: "every weekday 09:00 buy $1 of JUPF", words: "Every weekday at 09:00, buy $1 of JUPF.", paysFrom: "tee-one", runs: { runs: "own", words: "Runs on its own: tee-one trades inside limits. Each firing trades with a receipt while it fits $1.50 a trade and tee-one's $5.00 a day without a card; over them, it's a card that waits for you." }, watching: "next run 09:00 today", lastFired: at(82_800_000), armed: false }),
    view({ name: "conf", class: "tape", line: "when confluence mcap < 500k wake agent-a", words: "When Hacc's tape shows a confluence under $500k market cap, wake agent-a. Each token once in 30 min.", runs: { runs: "wakes", words: "Wakes agent-a: its trades run as yours would, inside the wallet's figures with a receipt, over them as a card." }, watching: "watches Hacc's tape for confluence", lastFired: at(120_000), cooldownMs: 1_800_000, armed: false }),
    view({ name: "dip buy", agent: "agent-b", line: "when JUPF down 20% buy $3 of JUPF again", words: "When JUPF is 20% under agent-b's entry, buy $3 of JUPF. Again each time it crosses back.", again: true, paysFrom: "embedded", runs: { runs: "asks", words: "Asks you each time: this buy, $3.01 with Candle's fee, is over the embedded wallet's $1.50 a trade without a card, so each firing is a card for you to approve or reject within 60 s." }, watching: "checked about every 5 s · JUPF $0.4249", lastFired: at(1_740_000), expired: { cardId: "c-dip", at: at(1_680_000) } }),
    view({ name: "bonk tp", on: false, live: false, line: "when BONKF up 50% sell 100% of BONKF", words: "When BONKF is 50% over your entry, sell all of it. Fires once, then switches off.", armed: false }),
  ],
}
const FREE: TriggersTopic = { gate: { plan: "free", words: "Triggers need a Pro or Max plan", fix: "candle plan buy" }, triggers: [], problems: [] }
const st = { ...status, triggersOn: 4 }

async function scene(width: number, height: number) {
  const drawn = await drawScene("followed", width, height, "trade")
  setup = drawn.setup
  const push = async (topic: string, data: unknown, snapshot = false) => {
    await act(async () => drawn.session.push(topic, data, snapshot))
    await drawn.setup.renderOnce()
  }
  await push("status", st, true)
  await push("triggers", TOPIC, true)
  return { ...drawn, push }
}

async function compare(name: string, s: Setup): Promise<void> {
  const chars = s.captureCharFrame()
  const runs = s
    .captureSpans()
    .lines.map((l, y) => `${y}: ${l.spans.map((sp) => `${[sp.fg.r, sp.fg.g, sp.fg.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}/${[sp.bg.r, sp.bg.g, sp.bg.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}${sp.attributes ? `+${sp.attributes}` : ""}×${sp.width}`).join(" ")}`)
    .join("\n")
  const got = `${chars}\n--- colours ---\n${runs}\n`
  const file = join(DIR, `${name}.txt`)
  if (UPDATE || !existsSync(file)) {
    if (!UPDATE) throw new Error(`No frame kept for ${name}: run with UPDATE_FRAMES=1 to keep this one.\n${got}`)
    mkdirSync(DIR, { recursive: true })
    writeFileSync(file, got)
    return
  }
  expect(got).toBe(readFileSync(file, "utf8"))
}

async function press(s: Setup, ...keys: (string | { key: string; ctrl?: boolean } | "up" | "down" | "left" | "right")[]) {
  for (const k of keys) {
    await act(async () => {
      if (k === "up" || k === "down" || k === "left" || k === "right") return s.mockInput.pressArrow(k)
      if (typeof k === "string") return s.mockInput.pressKey(k)
      return s.mockInput.pressKey(k.key, k.ctrl ? { ctrl: true } : {})
    })
    await s.renderOnce()
  }
}

/** The Triggers overlay from the palette, as settings ▾ → triggers opens it. */
const openOverlay = (s: Setup) => press(s, { key: "k", ctrl: true }, ..."triggers".split(""), "\r")

const LINE = "when JUPF < $0.40 sell 50% of JUPF"
const base = (cardId: string, over: Partial<ViewCard>, d: Partial<ViewCard["display"]>): ViewCard => ({
  cardId,
  opId: `op-${cardId}`,
  cardHash: `hash-${cardId}`,
  kind: "trade",
  tool: "candle_trade",
  agent: "agent-a",
  state: "awaiting_approval",
  expiresAt: new Date(CLOCK + 42_000).toISOString(),
  side: "buy",
  params: { mint: MINT, side: "buy", amountUsd: "3" },
  display: { title: "BUY $3.00 of JUPF", headline: "BUY $3.00 of JUPF", agent: "agent-a", wallet: EMBEDDED, walletLabel: "embedded", mode: "live", expiresAt: new Date(CLOCK + 42_000).toISOString(), mint: MINT, mintLabel: "JUPF", gets: { amount: 7.06, asset: "JUPF" }, valueUsd: 3, paysFrom: "pays from embedded", ...d },
  ...over,
})
const proposed = (asks: boolean): ViewCard =>
  base("t1", { kind: "trigger", tool: "harness_triggers", side: undefined, params: { line: LINE }, expiresAt: new Date(CLOCK + 590_000).toISOString() }, {
    title: 'NEW TRIGGER "jupf stop"',
    headline: 'NEW TRIGGER "jupf stop"',
    gets: undefined,
    valueUsd: undefined,
    walletLabel: undefined,
    why: "your stop under $0.40",
    expiresAt: new Date(CLOCK + 590_000).toISOString(),
    triggerCard: { line: LINE, words: "When JUPF's price falls below $0.40, sell 50% of JUPF. Fires once, then switches off.", runs: asks ? ASKS : "Runs on its own: the embedded wallet trades inside limits, and sells aren't limited. Each firing trades with a receipt.", kind: asks ? "asks" : "own" },
    ...(asks ? { warning: "The embedded wallet asks every time, so this will wait for you.", fills: [{ label: "new TEE wallet for agent-a", line: "candle vault promote --to-key ABCDEFGH --label agent-a-tee --from " }] } : {}),
  })

const ACTIVITY: ActivityEntry[] = [
  { seq: 1, at: at(840_000), agent: "agent-a", text: "agent-a proposed BUY $1.00 of JUPF", tone: "info" },
  { seq: 2, at: at(830_000), agent: "agent-a", text: "filled BUY $1.00 of JUPF", tone: "good" },
  { seq: 3, at: at(600_000), agent: "agent-a", text: 'you approved NEW TRIGGER "jupf stop"', tone: "info" },
  { seq: 4, at: at(120_000), agent: "agent-a", text: 'trigger "conf" fired: a confluence signal on BONKF', tone: "info", firing: { name: "conf", said: "a confluence signal on BONKF → woke agent-a" } },
  { seq: 5, at: at(9_000), agent: "agent-a", text: 'trigger "jupf stop" fired: JUPF was $0.3990, under $0.40', tone: "good", firing: { name: "jupf stop", said: "JUPF was $0.3990, under $0.40 → filled SELL 50% of JUPF in 5.0 s, without a card" } },
]

for (const [width, height] of SIZES) {
  test(`the Triggers overlay: the list and the picked trigger, at ${width}×${height}`, async () => {
    const d = await scene(width, height)
    await openOverlay(d.setup)
    const frame = d.setup.captureCharFrame()
    expect(frame).toContain("jupf stop")
    expect(frame).toContain("4 on · 1 off")
    if (width >= 100) {
      expect(frame).toContain("asks you each time")
      expect(frame).toContain("ask the agent to change it")
    } else expect(frame).toContain("→ its trigger")
    await compare(`triggers-${width}x${height}-overlay`, d.setup)
    // The trigger whose card expired: run it now, by its chip or ctrl-r.
    await press(d.setup, "down", "down", "down", "right")
    expect(d.setup.captureCharFrame()).toContain("run it now")
    await compare(`triggers-${width}x${height}-overlay-expired`, d.setup)
  })

  test(`a trigger's card, proposed: how it runs in a box of its own, at ${width}×${height}`, async () => {
    const d = await scene(width, height)
    await d.push("agent", { agent: "agent-a", turnId: "t2", type: "ended", user: "sell half my JUPF if it drops below 40c", reply: "Here's the stop as a trigger. Your embedded wallet asks every time, so each firing will be a card for you to press.", outcome: "done" })
    await d.push("cards", [proposed(true)], true)
    const frame = d.setup.captureCharFrame()
    expect(frame).toContain("╭─ asks you each time")
    expect(frame).toContain("new TEE wallet for agent-a")
    await compare(`triggers-${width}x${height}-proposed-asks`, d.setup)
    await d.push("cards", [proposed(false)], true)
    expect(d.setup.captureCharFrame()).toContain("╭─ runs on its own")
    await compare(`triggers-${width}x${height}-proposed-own`, d.setup)
  })

  test(`a firing, one line in the agent pane and in Activity, and a trigger's card waiting, at ${width}×${height}`, async () => {
    const d = await scene(width, height)
    await d.push("agent", { agent: "agent-a", turnId: "t3", type: "ended", user: 'the trigger "conf": a confluence signal on BONKF at 07:58', reply: "Woke on conf: BONKF fits your rule (mcap under $500k, 3 smart wallets). Bought $1 of BONKF without a card.", outcome: "done", woken: ["conf"] })
    const sold = base("t9", { side: "sell", state: "approved", approvedHow: "inside-limits", withoutCard: "without a card: the embedded wallet trades inside limits, and sells aren't limited", operation: { state: "succeeded" } }, { title: "SELL 50% of JUPF", headline: "SELL 50% of JUPF", trigger: "jupf stop", fired: "JUPF was $0.3990, under $0.40", gets: undefined, valueUsd: 7.4 })
    await d.push("operations", [{ opId: "op-t9", cardId: "t9", agent: "agent-a", state: "succeeded", kind: "trade", startedAt: CLOCK - 9_000, settledAt: CLOCK - 4_000 }], true)
    await d.push("cards", [sold], true)
    await d.push("activity", { lines: ACTIVITY }, true)
    const frame = d.setup.captureCharFrame()
    expect(frame).toContain("⚡ jupf stop")
    await compare(`triggers-${width}x${height}-firing`, d.setup)
    // A firing over the wallet's figure: a card, saying which trigger and what it saw.
    await d.push("cards", [sold, base("t10", {}, { trigger: "dip buy", fired: "JUPF was $0.3990, under $0.40", why: 'the trigger "dip buy" fired', cardBecause: "over the embedded wallet's $1.50 a trade without a card: this one is $3.01 with Candle's fee" })], true)
    const waiting = d.setup.captureCharFrame()
    expect(waiting).toContain("⚡ dip buy")
    expect(waiting).toContain("fired  JUPF was $0.3990")
    await compare(`triggers-${width}x${height}-waiting`, d.setup)
  })
}

test("the overlay's narrow trigger opens with → and goes back with its chip", async () => {
  const d = await scene(80, 24)
  await openOverlay(d.setup)
  await press(d.setup, "right")
  const frame = d.setup.captureCharFrame()
  expect(frame).toContain("‹ triggers")
  expect(frame).toContain("asks you each time")
  await compare("triggers-80x24-overlay-trigger", d.setup)
})

test("on Free, the overlay says a Pro or Max plan is needed, with candle plan buy", async () => {
  const d = await scene(120, 30)
  await d.push("triggers", FREE, true)
  await openOverlay(d.setup)
  const frame = d.setup.captureCharFrame()
  expect(frame).toContain("Triggers need a Pro or Max plan.")
  expect(frame).toContain("candle plan buy")
  await compare("triggers-120x30-free", d.setup)
})

test("the overlay's keys: ⏎ switches the picked trigger off, remove asks once, ctrl-t asks its agent", async () => {
  const d = await scene(120, 30)
  await openOverlay(d.setup)
  await press(d.setup, "\r")
  expect(d.session.requests.find((r) => r.method === "triggers.set")?.params).toEqual({ name: "jupf stop", on: false })
  await act(async () => d.setup.mockMouse.click(d.setup.captureCharFrame().split("\n").find((l) => l.includes(" remove "))!.indexOf(" remove ") + 2, d.setup.captureCharFrame().split("\n").findIndex((l) => l.includes(" remove "))))
  await d.setup.renderOnce()
  expect(d.setup.captureCharFrame()).toContain('Remove "jupf stop"?')
  expect(d.session.requests.some((r) => r.method === "triggers.remove")).toBe(false)
  await press(d.setup, "\r")
  expect(d.session.requests.find((r) => r.method === "triggers.remove")?.params).toEqual({ name: "jupf stop" })
  await press(d.setup, { key: "t", ctrl: true })
  expect(d.setup.captureCharFrame()).toContain('change the trigger "jupf stop":')
})

test("the status bar's chip opens the overlay; narrow, it keeps its noun", async () => {
  const d = await scene(120, 30)
  const top = d.setup.captureCharFrame().split("\n")[0]!
  expect(top).toContain("⚡ 4 triggers")
  await act(async () => d.setup.mockMouse.click(top.indexOf("⚡ 4 triggers") + 3, 0))
  await d.setup.renderOnce()
  expect(d.setup.captureCharFrame()).toContain("╭─ triggers ─")
  setup = undefined
  await act(async () => d.setup.dispose())
  const narrow = await scene(80, 24)
  expect(narrow.setup.captureCharFrame().split("\n")[0]).toContain("⚡ 4 triggers")
})

test("the Triggers pane: two lines a trigger, a chip to the overlay; before a read, empty and on Free, words", () => {
  const text = (lines: ReturnType<typeof triggersPaneLines>) => lines.map((l) => l.segs.map((s) => s.text).join(""))
  const lines = text(triggersPaneLines(TOPIC, 40, CLOCK))
  expect(lines.slice(0, 4)).toEqual(["● jupf stop                     asks you", "  about every 5 s · JUPF $0.4249", "● morning buy                 on its own", "  next run 09:00 today"])
  expect(lines).toContain("  card expired 07:32")
  expect(lines.at(-1)).toBe(" all triggers ")
  expect(text(triggersPaneLines(undefined, 40, CLOCK))).toEqual(["Reading the triggers…"])
  expect(text(triggersPaneLines({ triggers: [], problems: [] }, 60, CLOCK))[0]).toStartWith("No triggers yet. Ask the agent:")
  expect(text(triggersPaneLines(FREE, 60, CLOCK))).toEqual(["Triggers need a Pro or Max plan.", " candle plan buy "])
})
