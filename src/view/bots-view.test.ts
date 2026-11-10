// The Bots list's rows: the name column is as wide as the longest name, at most 24, and a name never runs into its mode.
import { expect, test } from "bun:test"
import { BOTS, BOTS_CODE } from "../../test/bots-scene"
import { CLOCK } from "../../test/frame-scenes"
import { botChips, botDetailLines, botListLines, botLogLines, botNamed, botNameWidth, botPart, botsCountWords, botsListLines, botTitle, everyBot, parseBotRef, pickedBot, positionLines, readBotLogLine } from "./bots-view"
import { botLogScrolled } from "./keys"
import { C } from "./theme"
import type { Line } from "./panes/lines"

process.env.TZ = "UTC"
const text = (l: { segs: { text: string }[] }) => l.segs.map((s) => s.text).join("")

test("a name as long as its column keeps a space before its mode", () => {
  const b = { ...BOTS.bots[0]!, name: "confluence-paper", mode: "paper" as const }
  const row = text(botListLines(b, undefined, 52, botNameWidth([b]))[0]!)
  expect(row).toContain("confluence-paper paper")
})

test("the name column fits the longest name, and a longer one than 24 is cut", () => {
  expect(botNameWidth([{ name: "conf" }, { name: "fresh" }])).toBe(5)
  const long = { ...BOTS.bots[0]!, name: "a-very-long-bot-name-for-the-tape", mode: "live" as const }
  const row = text(botListLines(long, undefined, 52, botNameWidth([long]))[0]!)
  expect(row).toMatch(/^● a-very-long-bot-name-fo… live/)
})

test("a position Candle has had no price for says since when, not a stale figure", () => {
  const since = new Date(2026, 10, 7, 22, 59).toISOString()
  const lines = positionLines({ id: "op-1", mint: "TaolfFake1111111111111111111111111111111111", token: "TAOLF", since: new Date(2026, 10, 7, 22, 40).toISOString(), costUsd: 2, entryUsd: 0.0001204, stopUsd: 0.0000722, noPriceSince: since }, 80, new Date(2026, 10, 8, 0, 12).getTime())
  expect(text(lines[0]!)).toContain("no price on Candle since 22:59")
  expect(text(lines[0]!)).not.toContain("%")
})

test("a position's gauge gives a stop and target under 10% to one decimal, so ±0.5% doesn't read −1% and +0%", () => {
  const at = new Date(2026, 10, 8, 0, 12).getTime()
  const lines = positionLines({ id: "op-2", mint: "JupFake111111111111111111111111111111111111", token: "JUP", since: new Date(at - 60_000).toISOString(), costUsd: 1, entryUsd: 0.2456, nowUsd: 0.2451, stopUsd: 0.2456 * 0.995, targetUsd: 0.2456 * 1.005 }, 80, at)
  expect(text(lines[0]!)).toContain("-0.5% ├")
  expect(text(lines[0]!)).toContain("┤ +0.5%")
  const wide = positionLines({ id: "op-3", mint: "JupFake111111111111111111111111111111111111", token: "JUP", since: new Date(at - 60_000).toISOString(), costUsd: 1, entryUsd: 1, nowUsd: 1, stopUsd: 0.6, targetUsd: 2 }, 80, at)
  expect(text(wide[0]!)).toContain("-40% ├")
  expect(text(wide[0]!)).toContain("┤ +100%")
})

test("right after a fill, before a price read, a position says it's waiting for one, not that Candle has no price", () => {
  const at = new Date(2026, 10, 8, 0, 12).getTime()
  const base = { id: "op-4", mint: "JupFake111111111111111111111111111111111111", token: "JUP", since: new Date(at - 5_000).toISOString(), costUsd: 1 }
  expect(text(positionLines({ ...base, entryUsd: 0.25 }, 80, at)[0]!)).toContain("waiting for its first price after the fill")
  expect(text(positionLines({ ...base, nowUsd: 0.25 }, 80, at)[0]!)).toContain("waiting for its entry price from the fill")
})

// Code bots on the Bots tab.
const flat = (lines: Line[]) => lines.map((l) => l.segs.map((s) => s.text).join("")).join("\n")
const momentum = BOTS_CODE.code![0]!
const relay = BOTS_CODE.code![1]!

test("the tab lists rules bots, then code bots; a pick by index or name reaches either, and on Free still lists them under the plan's words", () => {
  expect(everyBot(BOTS_CODE).map((b) => b.name)).toEqual(["conf", "fresh", "momentum", "relay"])
  expect(pickedBot(BOTS_CODE, 2)?.name).toBe("momentum")
  expect(botNamed(BOTS_CODE, "relay")?.kind).toBe("code")
  // A plan that ended holds their buys; what they bought is still theirs, and their sells still run.
  const free = { ...BOTS_CODE, gate: { plan: "free" as const, words: "Bots need a Pro or Max plan", fix: "candle plan buy" } }
  expect(everyBot(free).map((b) => b.name)).toEqual(["conf", "fresh", "momentum", "relay"])
  const listed = botsListLines(free, 60).map((l) => l.segs.map((s) => s.text).join(""))
  expect(listed[0]).toBe("Bots need a Pro or Max plan: their buys are held, and their")
  expect(listed[2]).toMatch(/candle plan buy +goes on the input line/)
  expect(listed.findIndex((l) => l.includes("conf"))).toBeGreaterThan(2)
  expect(botsCountWords(BOTS_CODE)).toBe("4 on · 2 live")
  expect(botTitle(momentum)).toBe("momentum · agent-a's · code bot")
})

test("a code bot's chips: its log only where the Candle Harness keeps one, start it only where its process isn't running, no go live or replay", () => {
  const book = BOTS_CODE.books!.momentum
  expect(botChips(momentum, book, 70)).toEqual(["pause", "stop", "flatten", "log", "ask", "remove"])
  expect(botChips(relay, BOTS_CODE.books!.relay, 70)).toEqual(["pause", "stop", "ask", "remove"])
  const crashed = { ...momentum, process: { ...momentum.process!, state: "gave_up" as const, words: "crashed 5 times in 10 min, so it isn't started again" } }
  expect(botChips(crashed, book, 70)).toContain("start")
  const stopped = { ...crashed, state: "stopped" as const }
  expect(botChips(stopped, book, 70)).not.toContain("start")
  const waiting = { ...momentum, heldExits: [{ ...momentum.heldExits![0]!, waits: "two sells of BONKY failed" }] }
  expect(botChips(waiting, book, 70)).toContain("retry")
})

test("a code bot's process line gives memory and CPU together, once CPU has a sample: never memory alone", () => {
  const first = { ...momentum, process: { ...momentum.process!, cpuPct: undefined } }
  const before = flat(botDetailLines(first, BOTS_CODE.books!.momentum, { width: 74, now: CLOCK }))
  expect(before).toContain("running here")
  expect(before).not.toContain(" MB")
  const after = flat(botDetailLines(momentum, BOTS_CODE.books!.momentum, { width: 74, now: CLOCK }))
  expect(after).toContain("41 MB · 0.4% CPU")
})

test("a paused code bot whose process is up doesn't read as running: the line says it takes no buys, with no green dot, and the count says paused", () => {
  const paused = { ...momentum, state: "paused" as const }
  const lines = botDetailLines(paused, BOTS_CODE.books!.momentum, { width: 90, now: CLOCK })
  const text = flat(lines)
  expect(text).toContain("its process is up · takes no buys while paused · up 2h 10m")
  expect(text).not.toContain("running here")
  const dot = lines.flatMap((l) => l.segs).find((sg) => sg.text === "● ")
  expect(dot?.fg).toBe(C.dim)
  // On, it's the green dot and "running here", as before.
  expect(botDetailLines(momentum, BOTS_CODE.books!.momentum, { width: 90, now: CLOCK }).flatMap((l) => l.segs).find((sg) => sg.text === "● ")?.fg).toBe(C.good)
  const only = { ...BOTS_CODE, bots: [], code: [paused] }
  expect(botsCountWords(only)).toBe("1 paused · 1 live")
  expect(botsCountWords({ ...only, code: [paused, { ...relay, state: "stopped" as const }] })).toBe("1 paused · 1 stopped · 1 live")
  expect(botsCountWords({ ...only, code: [paused, relay] })).toMatch(/^1 on/)
})

test("a code bot in full: the core's count first, what the bot says below and labelled as its words, never as figures", () => {
  const text = flat(botDetailLines(momentum, BOTS_CODE.books!.momentum, { width: 74, now: CLOCK }))
  const at = (s: string) => text.indexOf(s)
  expect(at("Runs bun run bot.ts in ~/candle-bots/momentum")).toBe(0)
  expect(text).toContain("exits held by the core")
  expect(text).toContain("WIFY    +12.5% no exits held: its code sells")
  expect(at("open 2 of 3")).toBeLessThan(at("the bot says"))
  expect(at("the bot says")).toBeLessThan(at("the core's count · from its fills"))
  expect(text).toContain("its own words, not the core's count")
  expect(text).toContain("offers   $1.00 a trade   at once")
  // Run elsewhere, saying nothing, with no fills: each part says so.
  const r = flat(botDetailLines(relay, BOTS_CODE.books!.relay, { width: 74, now: CLOCK }))
  expect(r).toContain("runs outside the Candle Harness · not connected")
  expect(r).toContain("The bot says nothing about itself yet")
  expect(r).toContain("No fills yet.")
  expect(r).not.toContain(" log ")
})

test("a held exit's chip names its bot and position; removing them asks once on that position", () => {
  const lines = botDetailLines(momentum, BOTS_CODE.books!.momentum, { width: 74, now: CLOCK })
  const refs = lines.flatMap((l) => l.segs.map((s) => (s as { ref?: string }).ref).filter(Boolean))
  expect(refs).toContain("dropExits:momentum/op-m2")
  expect(refs).toContain("control:momentum/smaller")
  expect(parseBotRef("dropExits:momentum/op-m2")).toEqual({ action: "dropExits", name: "momentum/op-m2" })
  expect(botPart("momentum/op-m2")).toEqual({ bot: "momentum", part: "op-m2" })
  expect(botPart("momentum")).toBeUndefined()
  const asking = flat(botDetailLines(momentum, BOTS_CODE.books!.momentum, { width: 74, now: CLOCK, confirm: { name: "momentum", what: "exits", position: "op-m2" } }))
  expect(asking).toContain("Remove the exits the core holds on BONKY?")
  expect(asking).toContain(" remove them ")
})

test("its log: each line its time and where it came from, the Candle Harness's own marked core; stderr alone on ask", () => {
  expect(readBotLogLine("2027-01-14T09:58:02.000Z err  warn: slow")).toEqual({ at: "2027-01-14T09:58:02.000Z", from: "err", text: "warn: slow" })
  expect(readBotLogLine("2027-01-14T09:12:04.000Z ---  started")).toMatchObject({ from: "core", text: "started" })
  expect(readBotLogLine("a line from before")).toEqual({ from: "out", text: "a line from before" })
  const held = { name: "momentum", lines: ["2027-01-14T09:12:04.000Z ---  started", "2027-01-14T09:12:05.000Z out  connected", "2027-01-14T09:58:02.000Z err  warn: slow"] }
  expect(botLogLines(held)).toEqual(["09:12:04 core   started", "09:12:05        connected", "09:58:02 stderr warn: slow"])
  expect(botLogLines(held, "err")).toEqual(["09:58:02 stderr warn: slow"])
  expect(botLogLines({ name: "momentum", lines: [] })[0]).toContain("Its log is empty")
  expect(botLogLines(undefined)).toEqual(["Reading its log…"])
  expect(botLogLines({ name: "x", error: 'No code bot named "x".' })).toEqual(['No code bot named "x".'])
})

test("the log sits at its newest line until scrolled up, and reaching the foot again leaves it there", () => {
  expect(botLogScrolled(undefined, -1, 20)).toBe(19)
  expect(botLogScrolled(19, 1, 20)).toBeUndefined()
  expect(botLogScrolled(5, -10, 20)).toBe(0)
  expect(botLogScrolled(undefined, -Infinity, 20)).toBe(0)
  expect(botLogScrolled(undefined, 1, 0)).toBeUndefined()
})

test("an exit that filled on the wrong side of what fired it says so, with why, rather than reading as a target that lost", () => {
  const conf = BOTS.bots[0]!
  const book = BOTS.books!.conf!
  const plain = flat(botDetailLines(conf, book, { width: 100, now: CLOCK }))
  expect(plain).toContain("sold MOONQ at its target")
  expect(plain).not.toContain("filled under it")
  expect(plain).not.toContain("market price and fills at Candle's quote")
  const against = {
    ...book,
    recent: [
      { at: book.recent[0]!.at, act: "out" as const, token: "FAIRX", reason: "take_profit", usd: 1.98, realizedUsd: -0.02 },
      { at: book.recent[1]!.at, act: "out" as const, token: "FAIRY", reason: "stop_loss", usd: 2.09, realizedUsd: 0.09 },
    ],
  }
  const said = flat(botDetailLines(conf, against, { width: 100, now: CLOCK }))
  expect(said).toContain("sold FAIRX at its target, filled under it")
  expect(said).toContain("sold FAIRY at its stop, filled over it")
  expect(said).toContain("An exit fires on Candle's market price and fills at Candle's quote")
})
