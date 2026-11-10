// Bots on screen, kept as frames: the Bots tab (the list and the picked bot, each open position on a line from its
// stop to its target), flatten's question, the overlay where no tab has the Bots pane (narrow, its bot opened),
// the plan's words on Free and none yet, a bot's card when the agent proposes it, a bot's line in Activity, and
// the status bar's chip; and code bots beside them, with what each says and its log. As triggers-frame.test.tsx
// keeps the triggers'.
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { act } from "react"
import type { ActivityEntry } from "../core/trade-log"
import { BOTS, BOTS_CODE, BOTS_FREE, BOTS_NONE } from "../../test/bots-scene"
import { advanceClock, CLOCK, drawScene, EMBEDDED, status } from "../../test/frame-scenes"
import { DEFAULT_TABS } from "./layouts-file"
import { memoryStore } from "./layouts-store"
import type { ViewCard } from "./store"
import { botTitle } from "./bots-view"
import type { KillReport } from "../core/kill"

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

const st = { ...status, triggersOn: 4, botsOn: 3, botsLive: 2 }
/** Every tab but Bots: the palette's and the chip's bots open the overlay. */
const NO_BOTS_TAB = DEFAULT_TABS.filter((t) => t.name !== "Bots")
  .map((t) => `[[tabs]]\nname = "${t.name}"\nlayout = "${t.layout}"\n`)
  .join("\n")

async function scene(width: number, height: number, tab: "trade" | "bots", topic = BOTS, layouts?: ReturnType<typeof memoryStore>) {
  const drawn = await drawScene("followed", width, height, tab, layouts)
  setup = drawn.setup
  const push = async (t: string, data: unknown, snapshot = false) => {
    await act(async () => drawn.session.push(t, data, snapshot))
    await drawn.setup.renderOnce()
  }
  await push("status", st, true)
  await push("bots", topic, true)
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

/** A click on the first chip whose text is `label`. */
async function clickChip(s: Setup, label: string) {
  const rows = s.captureCharFrame().split("\n")
  const y = rows.findIndex((r) => r.includes(` ${label} `))
  expect(y).toBeGreaterThan(-1)
  await act(async () => s.mockMouse.click(rows[y]!.indexOf(` ${label} `) + 2, y))
  await s.renderOnce()
  await act(async () => s.mockMouse.moveTo(0, 0))
  await s.renderOnce()
}

const openPalette = (s: Setup) => press(s, { key: "k", ctrl: true }, ..."rules bots".split(""), "\r")

const DEF = '{"chain":"solana","entry":{"source":"pattern","pattern":"confluence","filters":{"max_mcap_usd":500000,"max_age_minutes":60}},"exit":{"take_profit_pct":100,"stop_loss_pct":40,"max_hold_hours":24},"sizing":{"usd_per_trade":2,"max_concurrent":4}}'
const proposed = (): ViewCard => ({
  cardId: "b1",
  opId: "op-b1",
  cardHash: "hash-b1",
  kind: "bot",
  tool: "harness_bots",
  agent: "agent-a",
  state: "awaiting_approval",
  expiresAt: new Date(CLOCK + 590_000).toISOString(),
  params: { action: "save" },
  display: {
    title: 'NEW BOT "conf"',
    headline: 'NEW BOT "conf"',
    agent: "agent-a",
    wallet: EMBEDDED,
    walletLabel: "embedded",
    mode: "live",
    expiresAt: new Date(CLOCK + 590_000).toISOString(),
    paysFrom: "pays from embedded",
    modeNote: "live bot",
    warning: "The embedded wallet asks every time, so each of its buys will wait for you. A wallet of its own is the better way: the bot can lose only what that wallet holds, and its figures are the bot's alone.",
    fills: [{ label: "new TEE wallet for agent-a", line: "candle vault promote --to-key ABCDEFGH --label agent-a-tee --from " }],
    botCard: {
      name: "conf",
      words: "Buys $2 when several tracked wallets buy the same token, under $500K market cap and under 1 hour old. Sells at +100%, at -40%, or after 24 hours. At most 4 at once.",
      definition: DEF,
      mode: "live",
      runs: { kind: "asks", entries: "Its buys ask you each time: the embedded wallet asks every time, so each buy is a card you approve or reject within 60 s, and one you miss is skipped.", exits: "Its exits sell without a card on any wallet: you approve them now, with the bot.", amber: "the embedded wallet asks every time, so each of its buys will wait for you" },
      worst: "At worst 4 positions of up to $2.00 each are open at once: $8.00 at risk, plus Candle's fee.",
      parts: { buys: "each a card for you within 60 s; one you miss is skipped", sells: "on their own, on any wallet: you approve them now", worst: "4 open at $2.00: $8.00 at risk, plus Candle's fee", tested: "pass · 41 trades · +$9.12 · drawdown 18.4% · Jan 5 to Jan 12" },
      backtest: "Hacc's replay 4412 of this exact definition (2027-01-05 to 2027-01-12): pass, 41 trades, P&L +$9.12, drawdown 18.4%. A backtest is a model of the past: a pass is a reason to paper-trade, not to fund.",
      differs: "Hacc's backtest buys at its first price after the signal, often a minute or more later, and fills a stop 5% under its level. A live run buys within seconds of the signal and sells at the market, so the two can differ.",
    },
  },
})

/** A code bot's card, as a Build pane proposes it: live on the embedded wallet, so it leads with a wallet of its own. */
const codeProposed = (): ViewCard => {
  const card = proposed()
  const run = { agent: "agent-a", wallet: "embedded", mode: "live", folder: "/srv/bots/momentum", command: ["bun", "run", "bot.ts"], perTradeUsd: 2, perDayUsd: 10, maxOpen: 3 }
  return {
    ...card,
    cardId: "c1",
    opId: "op-c1",
    cardHash: "hash-c1",
    params: { action: "saveCode" },
    display: {
      ...card.display,
      title: 'NEW CODE BOT "momentum"',
      headline: 'NEW CODE BOT "momentum"',
      botCard: {
        name: "momentum",
        words: "Runs bun run bot.ts in /srv/bots/momentum.",
        definition: JSON.stringify(run),
        mode: "live",
        runs: { kind: "asks", entries: "Its buys ask you each time: the embedded wallet asks every time, so each buy is a card you approve or reject within 60 s, and one you miss is refused to the bot.", exits: "Its sells of what it bought run without a card on any wallet: you approve them now, with the bot.", amber: "the embedded wallet asks every time, so each of its buys will wait for you" },
        worst: "At worst 3 positions of up to $2.00 each are open at once: $6.00 at risk, and its buys spend at most $10.00 a day, plus Candle's fee.",
        parts: { buys: "each a card for you within 60 s; one you miss is refused to the bot", sells: "of what it bought, on their own, on any wallet: you approve them now", worst: "3 open at $2.00: $6.00 at risk, plus Candle's fee", tested: "The core holds this bot to these figures. What it trades inside them is its code's." },
        code: { folder: "/srv/bots/momentum", command: "bun run bot.ts", figures: "$2.00 a trade · $10.00 a day · 3 open at most", holds: "The core holds this bot to these figures. What it trades inside them is its code's." },
      },
    },
  }
}

const at = (ms: number) => new Date(CLOCK - ms).toISOString()
const ACTIVITY: ActivityEntry[] = [
  { seq: 1, at: at(1_500_000), agent: "agent-a", text: "filled BUY $1.00 of JUPF", tone: "good" },
  { seq: 2, at: at(900_000), agent: "agent-a", text: 'the bot "conf" proposed BUY $2.00 of BONKX', tone: "good", firing: { name: "conf", said: "bought BONKX, WIFZ · took profit on MOONQ · 3 skipped", bot: true } },
  { seq: 3, at: at(400_000), agent: "agent-a", text: 'the bot "conf" sold WIFZ at its stop', tone: "good", firing: { name: "conf", said: "sold WIFZ at its stop in 4.1 s", bot: true } },
]

for (const [width, height] of SIZES) {
  test(`the Bots tab: the list and the picked bot, each position from its stop to its target, at ${width}×${height}`, async () => {
    const d = await scene(width, height, "bots")
    const frame = d.setup.captureCharFrame()
    expect(frame).toContain("conf")
    expect(frame).toContain("3 bots")
    if (width >= 100) {
      expect(frame).toContain("open 2 of 4")
      expect(frame).toContain("╎")
    }
    await compare(`bots-tab-${width}x${height}`, d.setup)
  })

  test(`the Bots overlay where no tab has the Bots pane, from the palette, at ${width}×${height}`, async () => {
    const d = await scene(width, height, "trade", BOTS, memoryStore(NO_BOTS_TAB))
    await openPalette(d.setup)
    const frame = d.setup.captureCharFrame()
    expect(frame).toContain("╭─ bots ─")
    if (width >= 100) expect(frame).toContain("ask the agent to change it")
    else expect(frame).toContain("→ its bot")
    await compare(`bots-${width}x${height}-overlay`, d.setup)
    if (width < 100) {
      await press(d.setup, "right")
      expect(d.setup.captureCharFrame()).toContain("‹ bots")
      await compare(`bots-${width}x${height}-overlay-bot`, d.setup)
    }
  })

  test(`a bot's card, proposed: its box in labelled lines, the headline kept, at ${width}×${height}`, async () => {
    const d = await scene(width, height, "trade")
    await d.push("agent", { agent: "agent-a", turnId: "t2", type: "ended", user: "run a confluence bot under 500k, $2 a trade, live", reply: "Here's the bot. Your embedded wallet asks every time, so each buy would wait for you; a wallet of its own is the better way.", outcome: "done" })
    await d.push("cards", [proposed()], true)
    const frame = d.setup.captureCharFrame()
    expect(frame).toContain("new TEE wallet for agent-a")
    expect(frame).toContain("│ worst  4 open at $2.00")
    expect(frame).toContain('NEW BOT "conf"')
    // What the press approves is on screen at every size: the box's title, its buys and its sells. At 80×24 each is
    // one line and the steer's paragraph is given up for its chip.
    expect(frame).toContain("╭─ its buys ask you each time")
    expect(frame).toContain("│ buys   each a card for you")
    expect(frame).toContain("│ sells  on their own")
    if (width < 100) expect(frame).not.toContain("the bot can lose only")
    await compare(`bots-${width}x${height}-card`, d.setup)
  })

  test(`a code bot's card, proposed: its command, its figures as a labelled line, and what the core holds it to, at ${width}×${height}`, async () => {
    const d = await scene(width, height, "trade")
    await d.push("cards", [codeProposed()], true)
    const frame = d.setup.captureCharFrame()
    expect(frame).toContain('NEW CODE BOT "momentum"')
    expect(frame).toContain("new TEE wallet for agent-a")
    // Its command, its limits and its sells are what the press approves: on screen at every size.
    expect(frame).toContain("Runs bun run bot.ts in /srv/bots/momentum.")
    expect(frame).toContain("│ limits $2.00 a trade · $10.00 a day")
    expect(frame).toContain("│ sells  of what it bought")
    expect(frame).toContain("The core holds this bot to these figures.")
    if (width >= 100) {
      expect(frame).toContain("│ limits $2.00 a trade · $10.00 a day · 3 open at most")
      expect(frame).not.toContain("backtest")
    }
    await compare(`bots-${width}x${height}-code-card`, d.setup)
  })

  test(`three tall cards waiting each keep their headline and chips, their middles folded, at ${width}×${height}`, async () => {
    const d = await scene(width, height, "trade")
    const three = ["b1", "b2", "b3"].map((id, i) => ({ ...proposed(), cardId: id, opId: `op-${id}`, cardHash: `hash-${id}`, display: { ...proposed().display, headline: `NEW BOT "conf${i + 1}"` } }))
    await d.push("cards", three, true)
    const frame = d.setup.captureCharFrame()
    for (const i of [1, 2, 3]) expect(frame).toContain(`NEW BOT "conf${i}"`)
    // Each keeps its who line, whatever its headline's figures took.
    expect(frame.split("agent-a · pays from embedded").length - 1).toBe(3)
    expect(frame.split("⏎ approve").length - 1).toBeGreaterThanOrEqual(3)
  })

  test(`a bot's line in Activity, in its notice's words, at ${width}×${height}`, async () => {
    const d = await scene(width, height, "trade")
    await d.push("activity", { lines: ACTIVITY }, true)
    await compare(`bots-${width}x${height}-activity`, d.setup)
  })
}

test("flatten asks once in the picked bot's pane; its answer goes to the core, keep it sends nothing", async () => {
  const d = await scene(120, 30, "bots")
  await clickChip(d.setup, "flatten")
  expect(d.setup.captureCharFrame()).toContain('Flatten "conf"?')
  expect(d.session.requests.some((r) => r.method === "bots.flatten")).toBe(false)
  await compare("bots-120x30-flatten", d.setup)
  await clickChip(d.setup, "keep it")
  expect(d.setup.captureCharFrame()).not.toContain('Flatten "conf"?')
  await clickChip(d.setup, "flatten")
  // An answer straight after the ask is the press that opened it, reported twice: it sends nothing.
  await clickChip(d.setup, "flatten it")
  expect(d.session.requests.some((r) => r.method === "bots.flatten")).toBe(false)
  expect(d.setup.captureCharFrame()).toContain('Flatten "conf"?')
  advanceClock(450)
  await clickChip(d.setup, "flatten it")
  expect(d.session.requests.find((r) => r.method === "bots.flatten")?.params).toEqual({ name: "conf" })
})

test("flatten offers pause, then flatten, as two steps: the bot paused first, then its positions sold", async () => {
  const d = await scene(120, 30, "bots")
  await clickChip(d.setup, "flatten")
  const frame = d.setup.captureCharFrame()
  expect(frame).toContain("The bot stays on, so its next signal may buy again")
  expect(frame).toContain("pause, then flatten")
  advanceClock(450)
  await clickChip(d.setup, "pause, then flatten")
  await act(async () => Bun.sleep(10))
  const methods = d.session.requests.map((r) => r.method).filter((m) => m === "bots.pause" || m === "bots.flatten")
  expect(methods).toEqual(["bots.pause", "bots.flatten"])
  expect(d.session.requests.find((r) => r.method === "bots.flatten")?.params).toEqual({ name: "conf" })
})

test("the pane's chips: pause at once; ask puts the change on the input line for the agent", async () => {
  const d = await scene(120, 30, "bots")
  // One press, one request, even when the terminal reports the click twice: a second would land on the changed bot
  // and say it's "paused already", over the answer to the first.
  const rows = d.setup.captureCharFrame().split("\n")
  const y = rows.findIndex((r) => r.includes(" pause "))
  await act(async () => {
    d.setup.mockMouse.click(rows[y]!.indexOf(" pause ") + 2, y)
    d.setup.mockMouse.click(rows[y]!.indexOf(" pause ") + 2, y)
  })
  await d.setup.renderOnce()
  expect(d.session.requests.find((r) => r.method === "bots.pause")?.params).toEqual({ name: "conf" })
  expect(d.session.requests.filter((r) => r.method === "bots.pause")).toHaveLength(1)
  await act(async () => d.setup.mockMouse.moveTo(0, 0))
  await clickChip(d.setup, "ask the agent to change it")
  expect(d.setup.captureCharFrame()).toContain('change the bot "conf":')
})

test("↓ in the list picks the next bot for the pane beside it", async () => {
  const d = await scene(120, 30, "bots")
  const rows = d.setup.captureCharFrame().split("\n")
  const y = rows.findIndex((r) => r.includes("● fresh"))
  await act(async () => d.setup.mockMouse.click(rows[y]!.indexOf("fresh"), y))
  await d.setup.renderOnce()
  await press(d.setup, "down", "down", "down")
  await press(d.setup, "up", "up", "up")
  const frame = d.setup.captureCharFrame()
  expect(frame).toContain("fresh · agent-b's")
  expect(frame).toContain(" go live ")
})

test("the overlay's keys: ⏎ pauses the picked bot, ctrl-t asks its agent", async () => {
  const d = await scene(120, 30, "trade", BOTS, memoryStore(NO_BOTS_TAB))
  await openPalette(d.setup)
  await press(d.setup, "\r")
  expect(d.session.requests.find((r) => r.method === "bots.pause")?.params).toEqual({ name: "conf" })
  await press(d.setup, "down", "down", "\r")
  expect(d.session.requests.find((r) => r.method === "bots.resume")?.params).toEqual({ name: "woke" })
  await press(d.setup, { key: "t", ctrl: true })
  expect(d.setup.captureCharFrame()).toContain('change the bot "woke":')
})

test("on Free, and before any bot, the tab says why, with candle plan buy on Free", async () => {
  const d = await scene(120, 30, "bots", BOTS_FREE)
  expect(d.setup.captureCharFrame()).toContain("Bots need a Pro or Max plan.")
  expect(d.setup.captureCharFrame()).toContain("candle plan buy")
  await compare("bots-120x30-free", d.setup)
  await d.push("bots", BOTS_NONE, true)
  expect(d.setup.captureCharFrame()).toContain("No bots yet.")
  await compare("bots-120x30-none", d.setup)
})

test("on Free with bots saved, the tab lists them under the plan's words, and the picked one in full: what they bought still sells", async () => {
  const d = await scene(120, 30, "bots", { ...BOTS_CODE, gate: { plan: "free", words: "Bots need a Pro or Max plan", fix: "candle plan buy" } })
  const f = d.setup.captureCharFrame()
  expect(f).toContain("Bots need a Pro or Max plan: their")
  expect(f).toContain("● conf")
  expect(f).toContain(`╭─ ${botTitle(BOTS_CODE.bots[0]!)}`)
  expect(f).not.toContain("A rules bot runs a Hacc strategy for you")
})

test("the status bar's chip goes to the Bots tab, or the overlay where no tab has it", async () => {
  const d = await scene(120, 30, "trade")
  const top = d.setup.captureCharFrame().split("\n")[0]!
  expect(top).toContain(" 3 bots ")
  await act(async () => d.setup.mockMouse.click(top.indexOf(" 3 bots ") + 2, 0))
  await d.setup.renderOnce()
  expect(d.setup.captureCharFrame().split("\n")[1]).toContain("4 Bots")
  expect(d.setup.captureCharFrame()).toContain("╭─ Bots · 2 on · 2 live")
  setup = undefined
  await act(async () => d.setup.dispose())
  const o = await scene(120, 30, "trade", BOTS, memoryStore(NO_BOTS_TAB))
  const bar = o.setup.captureCharFrame().split("\n")[0]!
  await act(async () => o.setup.mockMouse.click(bar.indexOf(" 3 bots ") + 2, 0))
  await o.setup.renderOnce()
  expect(o.setup.captureCharFrame()).toContain("╭─ bots ─")
})

test("with the kill switch on, the Bots tab says its bots are held: in the list, on the bot, and in the short agent pane", async () => {
  const d = await scene(120, 30, "bots")
  await d.push("status", { ...st, paused: true }, true)
  const report: KillReport = {
    at: new Date(CLOCK - 1_000).toISOString(),
    by: "v1",
    stopped: { turns: [], cards: [] },
    stillOpen: [],
    inFlight: [],
    standing: { portfolioAgeMs: 30_000, wallets: [], pnl: { usd: 0, label: "24h", from: 0, short: false }, spentToday: [] },
    notStopped: { wording: "", steps: [], candleStopped: [] },
    resume: "Type resume, or use the status bar, to allow buys again.",
    botsHeld: [{ name: "conf", agent: "agent-a", mode: "live", open: ["JUPF"], words: "its entries are held until you resume; its exits still sell, guarding its JUPF position" }],
  }
  await d.push("activity", { kind: "kill.report", report })
  const frame = d.setup.captureCharFrame()
  expect(frame).toContain("KILL SWITCH ON")
  expect(frame).toContain('held        bot "conf"')
  expect(frame).toContain("held by the kill switch")
  expect(frame).toMatch(/Bots · \d held/)
})

test("a click on a bot's position picks its token, as a row in a list does", async () => {
  const d = await scene(120, 30, "bots")
  const rows = d.setup.captureCharFrame().split("\n")
  const y = rows.findIndex((r) => /│\s*BONKX\s/.test(r))
  expect(y).toBeGreaterThan(0)
  await act(async () => d.setup.mockMouse.click(rows[y]!.indexOf("BONKX") + 1, y))
  await d.setup.renderOnce()
  expect(d.session.requests.some((r) => JSON.stringify(r.params ?? {}).includes("BonkxFake11111111111111111111111111111111111"))).toBe(true)
})

test("a live bot on a shared wallet keeps the way to a wallet of its own after it's approved: the card's chip, on the bot", async () => {
  const line = "candle vault promote --to-key AbCdEfGh --label agent-a-tee --from cold-key"
  const d = await scene(120, 30, "bots", { ...BOTS, bots: BOTS.bots.map((b) => (b.name === "conf" ? { ...b, sharedWith: ["you and every agent"], ownWallet: [{ label: "new TEE wallet for agent-a", line }] } : b)) })
  expect(d.setup.captureCharFrame()).toContain("Its wallet is shared with you and every agent.")
  await clickChip(d.setup, "new TEE wallet for agent-a")
  expect(d.setup.captureCharFrame()).toContain(line)
})

// Code bots on the Bots tab: one column, the core's count first and what the bot says below.
const pickMomentum = async (s: Setup) => {
  const rows = s.captureCharFrame().split("\n")
  const y = rows.findIndex((r) => /● momentum /.test(r))
  expect(y).toBeGreaterThan(0)
  await act(async () => s.mockMouse.click(rows[y]!.indexOf("momentum") + 1, y))
  await s.renderOnce()
  await act(async () => s.mockMouse.moveTo(0, 0))
  await s.renderOnce()
}

for (const [width, height] of SIZES) {
  test(`a code bot on the Bots tab: its command and process, its figures and use, a position from its stop to its target and one its code sells, at ${width}×${height}`, async () => {
    const d = await scene(width, height, "bots", BOTS_CODE)
    expect(d.setup.captureCharFrame()).toContain("agent-a · embedded · code")
    await pickMomentum(d.setup)
    // Narrow, the tab is one switched pane: → goes from the list to the picked bot.
    if (width < 100) await press(d.setup, "right")
    const frame = d.setup.captureCharFrame()
    expect(frame).toContain("momentum · agent-a's · code bot")
    expect(frame).toContain("Runs bun run bot.ts in ~/candle-bots/momentum")
    expect(frame).toContain("running here · up 2h 10m · no restarts · 41 MB · 0.4% CPU")
    expect(frame).toContain("$4.00 of $10.00 today")
    await compare(`bots-${width}x${height}-code`, d.setup)
  })
}

test("a code bot scrolled to what it says: headed as its own words, its offer as a chip, then the core's count below", async () => {
  const d = await scene(120, 30, "bots", BOTS_CODE)
  await pickMomentum(d.setup)
  for (let i = 0; i < 3; i++) await act(async () => d.setup.mockMouse.scroll(80, 10, "down"))
  await d.setup.renderOnce()
  const frame = d.setup.captureCharFrame()
  expect(frame).toContain("the bot says · 12s ago · its own words, not the core's count")
  expect(frame).toContain("no exits held: its code sells")
  await compare("bots-120x30-code-says", d.setup)
  await clickChip(d.setup, "$1.00 a trade")
  expect(d.session.requests.find((r) => r.method === "bots.control")?.params).toEqual({ name: "momentum", id: "smaller" })
})

test("a code bot's log opens over the frame at its newest line; stderr only, Esc closes, and a click adds no pane", async () => {
  const d = await scene(120, 30, "bots", BOTS_CODE)
  await pickMomentum(d.setup)
  await clickChip(d.setup, "log")
  expect(d.session.requests.find((r) => r.method === "bots.logs")?.params).toEqual({ name: "momentum", lines: 2000 })
  let frame = d.setup.captureCharFrame()
  expect(frame).toContain("momentum · its log")
  expect(frame).toContain("stderr warn: Hacc read slow")
  expect(frame).toContain("core   started: bun run bot.ts")
  await compare("bots-120x30-code-log", d.setup)
  await clickChip(d.setup, "stderr only")
  frame = d.setup.captureCharFrame()
  expect(frame).not.toContain("connected as momentum")
  expect(frame).toContain("Hacc read slow")
  await press(d.setup, { key: "escape" })
  await act(async () => Bun.sleep(30))
  await d.setup.renderOnce()
  expect(d.setup.captureCharFrame()).not.toContain("its log")
})

test("a code bot's held exits: removing them asks once, then goes to the core; a bot run elsewhere says it isn't connected", async () => {
  const d = await scene(120, 30, "bots", BOTS_CODE)
  expect(d.setup.captureCharFrame()).toContain("runs outside · not connected")
  await pickMomentum(d.setup)
  await clickChip(d.setup, "remove its exits")
  expect(d.setup.captureCharFrame()).toContain("Remove the exits the core holds on BONKY?")
  expect(d.session.requests.some((r) => r.method === "bots.exits.remove")).toBe(false)
  advanceClock(450)
  await clickChip(d.setup, "remove them")
  expect(d.session.requests.find((r) => r.method === "bots.exits.remove")?.params).toEqual({ name: "momentum", position: "op-m2" })
})

test("a code bot run elsewhere, saying nothing yet, with no fills: each part of its pane says so", async () => {
  const d = await scene(120, 30, "bots", BOTS_CODE)
  const rows = d.setup.captureCharFrame().split("\n")
  const y = rows.findIndex((r) => /● relay /.test(r))
  await act(async () => d.setup.mockMouse.click(rows[y]!.indexOf("relay") + 1, y))
  await d.setup.renderOnce()
  await act(async () => d.setup.mockMouse.moveTo(0, 0))
  await d.setup.renderOnce()
  const frame = d.setup.captureCharFrame()
  expect(frame).toContain("runs outside the Candle Harness · not connected")
  expect(frame).toContain("Nothing open.")
  expect(frame).not.toContain(" log ")
  await compare("bots-120x30-code-outside", d.setup)
})
