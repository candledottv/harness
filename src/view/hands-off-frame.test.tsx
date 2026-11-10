// Trading inside limits on screen:
// the approvals menu (wallets left, the picked one right), the receipt where a card would be (like a
// card that ended), a card a wallet's figure sent to you, the Wallets pane's line, and the kill report
// naming a wallet the pause holds. Kept as frames, as frames.test.tsx keeps the Trade tab's.
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { act } from "react"
import type { AutonomyTopic } from "../core/autonomy"
import type { KillReport } from "../core/kill"
import { CLOCK, drawScene, EMBEDDED, MINT, status, TEE } from "../../test/frame-scenes"
import type { ViewCard } from "./store"

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

const autonomy: AutonomyTopic = {
  read: true,
  wallets: [
    { wallet: EMBEDDED, name: "embedded", kind: "embedded", setting: "inside", perTradeUsd: 1.5, perDayUsd: 5, usedTodayUsd: 3, agents: ["agent-a", "agent-b"], notes: [] },
    { wallet: TEE, name: "tee-one", kind: "tee", setting: "ask", usedTodayUsd: 0, agents: ["agent-a"], notes: [] },
  ],
}

const limited = {
  ...status,
  agents: [
    {
      ...status.agents[0]!,
      limitLines: [
        { by: "Harness" as const, what: "trade" as const, words: "Harness · $25.00 a trade" },
        { by: "Harness" as const, what: "day" as const, words: "Harness · $100.00 a day · $12.00 used" },
        { by: "Harness" as const, what: "wallet-trade" as const, wallet: EMBEDDED, words: "Harness · embedded without a card · $1.50 a trade" },
        { by: "Harness" as const, what: "wallet-day" as const, wallet: EMBEDDED, words: "Harness · embedded without a card · $5.00 a day · $3.00 used" },
        { by: "Candle" as const, what: "volume" as const, words: "Candle · $50.00 a UTC day, all volume" },
      ],
    },
    {
      ...status.agents[1]!,
      limitLines: [
        { by: "Harness" as const, what: "trade" as const, words: "Harness · $10.00 a trade" },
        { by: "Harness" as const, what: "day" as const, words: "Harness · $50.00 a day · $0.00 used" },
        { by: "Candle" as const, what: "none" as const, words: "Candle · no cap on this key" },
      ],
    },
  ],
}

const WORDS = "without a card, inside the embedded wallet's limits ($1.00 of $1.50 a trade, $3.00 of $5.00 today)"
const base = (cardId: string, over: Partial<ViewCard["display"]>): ViewCard => ({
  cardId,
  opId: `op-${cardId}`,
  cardHash: `hash-${cardId}`,
  kind: "trade",
  tool: "candle_trade",
  agent: "agent-a",
  state: "awaiting_approval",
  expiresAt: new Date(CLOCK + 58_000).toISOString(),
  side: "buy",
  params: { mint: MINT, side: "buy", amountUsd: "1" },
  display: { title: "BUY $1.00 of JUPF", headline: "BUY $1.00 of JUPF", agent: "agent-a", wallet: EMBEDDED, walletLabel: "embedded", mode: "live", expiresAt: new Date(CLOCK + 58_000).toISOString(), mint: MINT, mintLabel: "JUPF", gets: { amount: 2.35, asset: "JUPF" }, valueUsd: 1, ...over },
})
/** The $1 buy the core ran without a card, filled in 4.2 s. */
const ran: ViewCard = { ...base("c5", {}), state: "approved", approvedHow: "inside-limits", withoutCard: WORDS, operation: { state: "succeeded" } }
/** A $3 buy over the wallet's $1.50 a trade: a card, saying which figure. */
const over: ViewCard = {
  ...base("c6", { title: "BUY $3.00 of JUPF", headline: "BUY $3.00 of JUPF", gets: { amount: 7.06, asset: "JUPF" }, valueUsd: 3, why: "you asked for $3 more", cardBecause: "over the embedded wallet's $1.50 a trade without a card: this one is $3.01 with Candle's fee" }),
  params: { mint: MINT, side: "buy", amountUsd: "3" },
}

async function handsOff(width: number, height: number, kill = false) {
  const drawn = await drawScene("followed", width, height, "trade", undefined, kill ? { kill: true } : {})
  setup = drawn.setup
  const push = async (topic: string, data: unknown, snapshot = false) => {
    await act(async () => drawn.session.push(topic, data, snapshot))
    await drawn.setup.renderOnce()
  }
  await push("autonomy", autonomy, true)
  await push("status", kill ? { ...limited, paused: true } : limited, true)
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

/** The approvals menu from the palette, as settings ▾ → approvals opens it. */
const openMenu = (s: Setup) => press(s, { key: "k", ctrl: true }, ..."approvals".split(""), "\r")

for (const [width, height] of SIZES) {
  test(`the receipt where a card would be, and a card a figure sent to you, at ${width}×${height}`, async () => {
    const d = await handsOff(width, height)
    // The scene's own card goes: this conversation is a $1 buy that ran, then a $3 one over the figure.
    await d.push("agent", { agent: "agent-a", turnId: "t2", type: "ended", user: "buy $1 of JUPF", reply: "Bought. It ran without a card, inside the embedded wallet's limits.", outcome: "done" })
    await d.push("operations", [{ opId: "op-c5", cardId: "c5", agent: "agent-a", state: "succeeded", kind: "trade", startedAt: CLOCK - 6_000, settledAt: CLOCK - 1_800 }], true)
    await d.push("cards", [ran], true)
    await d.push("agent", { agent: "agent-a", turnId: "t3", type: "ended", user: "and $3 more", reply: "$3 is over the embedded wallet's $1.50 a trade without a card, so it's yours to approve.", outcome: "done" })
    await d.push("cards", over)
    const frame = d.setup.captureCharFrame()
    expect(frame).toContain("✓ BUY $1.00 of JUPF")
    expect(frame).toContain("filled in 4.2 s")
    expect(frame).toContain(" sell ")
    expect(frame).toContain("over the embedded wallet's $1.50 a trade")
    await compare(`hands-off-${width}x${height}-receipt`, d.setup)
  })

  test(`the approvals menu as it opens, at ${width}×${height}`, async () => {
    const d = await handsOff(width, height)
    await openMenu(d.setup)
    const frame = d.setup.captureCharFrame()
    expect(frame).toContain("approvals")
    expect(frame).toContain("inside limits")
    expect(frame).toContain("asks every time")
    // Below 100 columns the list takes the width, and → opens the picked wallet.
    if (width >= 100) expect(frame).toContain("no cap on this key")
    else expect(frame).not.toContain("no cap on this key")
    await compare(`hands-off-${width}x${height}-menu`, d.setup)
    if (width < 100) {
      await press(d.setup, "right")
      expect(d.setup.captureCharFrame()).toContain("no cap on this key")
      expect(d.setup.captureCharFrame()).toContain("‹ wallets")
    }
    // On, the menu says sells aren't held to the figures, and that a looser slippage still asks.
    expect(d.setup.captureCharFrame()).toContain("No card inside both figures or for sells; looser slippage asks.")
  })

  test(`turning a wallet on, its day's figure being typed, at ${width}×${height}`, async () => {
    const d = await handsOff(width, height)
    await openMenu(d.setup)
    await press(d.setup, "down", "right", "\r", "2", "\r", "1", "0")
    const frame = d.setup.captureCharFrame()
    expect(frame).toContain("Turn on trading inside limits")
    expect(frame).toContain("$10▏")
    // What the figures don't hold is said before the click that turns it on.
    expect(frame).toContain("Sells run with no card, at any size, unless slippage is looser.")
    expect(d.session.requests.some((r) => r.method === "autonomy.set")).toBe(false)
    await compare(`hands-off-${width}x${height}-menu-turning`, d.setup)
  })

  test(`the kill report names a wallet the pause holds, at ${width}×${height}`, async () => {
    const d = await handsOff(width, height, true)
    const report: KillReport = {
      at: new Date(CLOCK - 40_000).toISOString(),
      by: "v1",
      stopped: { turns: [{ agent: "agent-a", turnId: "t2" }], cards: [{ cardId: "c1", title: "BUY 0.1 SOL (≈$15.00) → JUPF", agent: "agent-a" }] },
      stillOpen: [{ cardId: "c2", cardHash: "hash-c2", title: "SELL 50% JUPF (≈$7.40)", agent: "agent-a", kind: "trade", side: "sell" }],
      inFlight: [],
      standing: { portfolioAgeMs: 30_000, wallets: [], pnl: { usd: 3.4, label: "24h", from: 0, short: false }, spentToday: [{ agent: "agent-a", usd: 12, perDayUsd: 100 }] },
      notStopped: { wording: "Bots and other apps using these keys aren't stopped.", steps: [], candleStopped: [] },
      resume: "type resume",
      insideLimits: [{ wallet: EMBEDDED, name: "embedded", words: "embedded wallet: trades inside limits, held by the pause. Its sells still go." }],
    }
    await d.push("activity", { kind: "kill.report", report })
    // Wherever it wraps, the whole line shows: what the pause holds, and that sells still go.
    const frame = d.setup.captureCharFrame()
    expect(frame).toContain("held        embedded wallet: inside limits,")
    expect(frame).toContain("sells go ")
    await compare(`hands-off-${width}x${height}-kill`, d.setup)
  })
}

test("the Wallets pane says which wallet trades inside limits, and today's use without a card", async () => {
  const d = await handsOff(160, 45)
  expect(d.setup.captureCharFrame()).toContain("inside limits · $3.00 of $5.00 today")
})

test("the menu's turn-on chip sends the wallet and its figures, and only then", async () => {
  const d = await handsOff(160, 45)
  await openMenu(d.setup)
  await press(d.setup, "down", "right", "\r", "2", "\r", "1", "0", "\r", "\r")
  expect(d.session.requests.filter((r) => r.method === "autonomy.set")).toEqual([{ method: "autonomy.set", params: { wallet: TEE, setting: "inside", perTradeUsd: 2, perDayUsd: 10 } }])
})

test("a trade sent without a card that Candle refused says so, and drops the figures it was sent at, since the core handed them back", async () => {
  const { cardLines } = await import("./panes/card")
  const message = "This agent's Candle key limit is used up. Nothing was sent."
  const refused: ViewCard = { ...ran, operation: { state: "failed" } }
  const op = { opId: "op-c5", cardId: "c5", agent: "agent-a", state: "failed", kind: "trade", error: { code: "KEY_LIMIT_REACHED", message } } as never
  const text = cardLines(refused, { now: CLOCK, focused: false, width: 90, op }).map((l) => l.segs.map((s) => s.text).join(""))
  expect(text.join("\n")).toContain("failed · without a card")
  expect(text.join("\n")).toContain("Nothing was sent.")
  expect(text.join("\n")).not.toContain("Nothing was sent. ·")
  expect(text.join("\n")).not.toContain("of $5.00 today")
  // A trade that ran keeps them.
  const filled = cardLines(ran, { now: CLOCK, focused: false, width: 90, op: { ...(op as object), state: "succeeded", error: undefined } as never }).map((l) => l.segs.map((s) => s.text).join(""))
  expect(filled.join("\n")).toContain("of $5.00 today")
})
