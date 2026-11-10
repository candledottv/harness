// What each journal row tells the person, and how the core's notifier sends it: one notification for rows that
// come together, a card left out once it no longer waits, a held key told once, the main view first, the
// machine's own notification only where it can show one.
import { expect, test } from "bun:test"
import { DEFAULT_NOTIFY, type Notice, type NotifySettings } from "../shared/notify"
import type { JournalRow } from "./journal"
import { CoreNotifier, rowNotice } from "./notifier"

let seq = 0
const row = (type: string, extra: Record<string, unknown> = {}): JournalRow => ({ seq: ++seq, at: "2026-11-04T12:00:00.000Z", type, mode: "live", ...extra }) as JournalRow
const none = () => undefined

test("the agent's card waits for the person; theirs, a trigger's and a replacement aren't told here", () => {
  expect(rowNotice(row("card.created", { role: "harness", agent: "agent-a", cardId: "c1" }), "agent-a proposed BUY $5 of JUP", none)).toEqual({ kind: "cards", words: "agent-a proposed BUY $5 of JUP", cardId: "c1" })
  // A woken turn's card is the agent's too.
  expect(rowNotice(row("card.created", { role: "harness", woken: "dip", cardId: "c2" }), "woke on trigger \"dip\" · agent-a proposed BUY", none)?.kind).toBe("cards")
  expect(rowNotice(row("card.created", { role: "view", cardId: "c3" }), "you proposed", none)).toBeUndefined()
  expect(rowNotice(row("card.created", { role: "core", trigger: "dip", cardId: "c4" }), "trigger \"dip\" proposed", none)).toBeUndefined()
  expect(rowNotice(row("card.created", { role: "harness", replaces: "c0", cardId: "c5" }), "re-proposed", none)).toBeUndefined()
})

test("a trigger's rows: its notice, a waiting card, a run, a wake, a miss, the kill switch's hold, a card nobody pressed", () => {
  expect(rowNotice(row("trigger.notify", { name: "dip" }), 'trigger "dip": MOON is down', none)).toEqual({ kind: "triggers", words: 'trigger "dip": MOON is down' })
  expect(rowNotice(row("trigger.waiting", { name: "dip", cardId: "c1" }), "w", none)).toEqual({ kind: "cards", words: "w", cardId: "c1" })
  for (const type of ["trigger.ran", "trigger.woke", "trigger.missed"]) expect(rowNotice(row(type, { name: "dip" }), "x", none)?.kind).toBe("triggers")
  expect(rowNotice(row("trigger.held", { name: "dip" }), "held", none)?.kind).toBe("triggers")
  // The plan's hold names every trigger, with no name of its own: the Triggers overlay says it.
  expect(rowNotice(row("trigger.held", { names: ["a", "b"] }), undefined, none)).toBeUndefined()
  expect(rowNotice(row("trigger.wake_skipped", { name: "dip" }), "skipped", none)?.kind).toBe("wakes")
  expect(rowNotice(row("card.expired", { trigger: "dip", cardId: "c1" }), "expired", none)?.kind).toBe("triggers")
  expect(rowNotice(row("card.expired", { cardId: "c1" }), "expired", none)).toBeUndefined()
  // An agent switching off a trigger that sells takes a stop away: told. Any other switch-off or narrowing isn't, nor the person's own.
  expect(rowNotice(row("trigger.changed", { name: "stop", agent: "agent-a", on: false, how: "agent", changedBy: "agent-b", sells: ["MoonFake"] }), 'agent-b switched off trigger "stop": its sell of MOON no longer waits', none)).toEqual({ kind: "triggers", words: 'agent-b switched off trigger "stop": its sell of MOON no longer waits' })
  expect(rowNotice(row("trigger.changed", { name: "note", on: false, how: "agent", changedBy: "agent-a" }), "x", none)).toBeUndefined()
  expect(rowNotice(row("trigger.changed", { name: "stop", hash: "h", on: true, how: "agent", sells: ["MoonFake"], narrowed: ["its amount"] }), "x", none)).toBeUndefined()
  expect(rowNotice(row("trigger.changed", { name: "stop", on: false, how: "view", sells: ["MoonFake"] }), "x", none)).toBeUndefined()
  // A firing alone isn't told: what it did is.
  expect(rowNotice(row("trigger.fired", { name: "dip" }), "fired", none)).toBeUndefined()
  expect(rowNotice(row("kill.on"), "kill switch on: buys paused", none)).toEqual({ kind: "kill", words: "kill switch on: buys paused" })
})

test("a trade nobody was there for: a trigger's or a woken turn's fill or failure; anyone else's isn't told", () => {
  const origin = (opId: string) => (opId === "t" ? { trigger: "dip" } : opId === "w" ? { woken: "dip" } : undefined)
  expect(rowNotice(row("operation.succeeded", { opId: "t" }), 'filled SELL 50% of MOON · by trigger "dip"', origin)).toEqual({ kind: "triggers", words: 'filled SELL 50% of MOON · by trigger "dip"' })
  expect(rowNotice(row("operation.failed", { opId: "t" }), "failed SELL 50% of MOON: X", origin)?.words).toBe('failed SELL 50% of MOON: X · by trigger "dip"')
  expect(rowNotice(row("operation.failed", { opId: "w" }), "failed BUY", origin)?.words).toBe('failed BUY · woke on trigger "dip"')
  expect(rowNotice(row("operation.succeeded", { opId: "p" }), "filled BUY", origin)).toBeUndefined()
})

test("Candle holding a key is told whoever's trade it was, in Candle's words", () => {
  const cap = rowNotice(row("operation.failed", { opId: "p", agent: "agent-a", error: { code: "KEY_LIMIT_REACHED" } }), "failed BUY $5 of JUP: KEY_LIMIT_REACHED: cap reached", none)!
  expect(cap.kind).toBe("keys")
  expect(cap.words).toBe("Candle held agent-a's key: its cap is reached, so its buys and swaps wait; sells still go. failed BUY $5 of JUP: KEY_LIMIT_REACHED: cap reached")
  expect(rowNotice(row("operation.refused", { opId: "p", agent: "agent-a", error: { code: "RISK_LIMIT_REACHED" } }), undefined, none)?.words).toMatch(/loss limit or the circuit breaker stopped it, so every trade waits/)
})

function notifier(o: { settings?: NotifySettings; target?: string; waiting?: (id: string) => boolean; native?: boolean; spawn?: (argv: string[]) => Promise<{ exitCode: number; stderr: string }> } = {}) {
  const published: { data: { notice: Notice }; clientId: string }[] = []
  const spawned: string[][] = []
  const journal: Record<string, unknown>[] = []
  let now = 0
  const n = new CoreNotifier({
    settings: o.settings ?? DEFAULT_NOTIFY,
    now: () => now,
    target: () => o.target,
    publish: (data, clientId) => published.push({ data, clientId }),
    waiting: o.waiting ?? (() => true),
    origin: () => ({ trigger: "dip" }),
    native: o.native ?? true,
    platform: "darwin",
    spawn: o.spawn ?? (async (argv) => (spawned.push(argv), { exitCode: 0, stderr: "" })),
    journal: { append: async (r) => journal.push(r) },
    quietMs: 20,
    maxWaitMs: 60,
  })
  return { n, published, spawned, journal, tick: (ms: number) => (now += ms) }
}

test("with a main view open, the notice goes to it alone and the core shows nothing", async () => {
  const t = notifier({ target: "view-1" })
  t.n.row(row("trigger.notify", { name: "dip" }), 'trigger "dip": MOON is down 20%')
  await t.n.flush()
  expect(t.published).toEqual([{ clientId: "view-1", data: { notice: { kinds: ["triggers"], title: "Candle Harness · trigger", body: 'trigger "dip": MOON is down 20%' } } }])
  expect(t.spawned).toEqual([])
})

test("with none, the core shows it on the machine, and journals that it did", async () => {
  const t = notifier()
  t.n.row(row("trigger.notify", { name: "dip" }), 'trigger "dip": MOON is down')
  await t.n.flush()
  expect(t.spawned).toHaveLength(1)
  expect(t.spawned[0]!.slice(-2)).toEqual(["Candle Harness · trigger", 'trigger "dip": MOON is down'])
  expect(t.journal).toEqual([{ type: "notify.sent", by: "core", via: "osascript", kinds: ["triggers"] }])
})

test("rows that come together are one notification, sent once they've been quiet", async () => {
  const t = notifier()
  t.n.row(row("operation.succeeded", { opId: "a" }), 'filled SELL 50% of MOON · by trigger "dip"')
  t.n.row(row("trigger.ran", { name: "dip" }), 'trigger "dip": done')
  await Bun.sleep(5)
  expect(t.spawned).toHaveLength(0)
  await Bun.sleep(40)
  expect(t.spawned).toHaveLength(1)
  expect(t.spawned[0]!.slice(-2)).toEqual(["Candle Harness · trigger · 2 updates", 'filled SELL 50% of MOON · by trigger "dip" · trigger "dip": done'])
})

test("a card that no longer waits when it's sent (it ran without one, or was approved) is left out; one card is told once", async () => {
  const t = notifier({ waiting: (id) => id === "c2" })
  t.n.row(row("card.created", { role: "harness", cardId: "c1" }), "agent-a proposed BUY $1 of JUP")
  await t.n.flush()
  expect(t.spawned).toHaveLength(0)
  t.n.row(row("card.created", { role: "harness", cardId: "c2" }), "agent-a proposed BUY $5 of JUP")
  t.n.row(row("trigger.waiting", { name: "dip", cardId: "c2" }), "again")
  await t.n.flush()
  expect(t.spawned.map((a) => a.at(-1))).toEqual(["agent-a proposed BUY $5 of JUP"])
})

test("a held key is told once while it holds", async () => {
  const t = notifier()
  const held = () => row("operation.failed", { opId: "p", agent: "agent-a", error: { code: "KEY_LIMIT_REACHED" } })
  t.n.row(held(), "failed BUY")
  await t.n.flush()
  t.tick(60_000)
  t.n.row(held(), "failed BUY")
  await t.n.flush()
  expect(t.spawned).toHaveLength(1)
  t.tick(10 * 60_000)
  t.n.row(held(), "failed BUY")
  await t.n.flush()
  expect(t.spawned).toHaveLength(2)
})

test("[notify] on leaves a kind out; off sends nothing; bell or osc never shows the machine's own", async () => {
  const kinds = notifier({ settings: { mode: "auto", on: ["cards"] } })
  kinds.n.row(row("trigger.notify", { name: "dip" }), "x")
  kinds.n.row(row("kill.on"), "kill")
  await kinds.n.flush()
  expect(kinds.spawned).toHaveLength(0)
  const off = notifier({ settings: { mode: "off", on: DEFAULT_NOTIFY.on }, target: "view-1" })
  off.n.row(row("trigger.notify", { name: "dip" }), "x")
  await off.n.flush()
  expect(off.published).toHaveLength(0)
  for (const mode of ["bell", "osc"] as const) {
    const t = notifier({ settings: { mode, on: DEFAULT_NOTIFY.on } })
    t.n.row(row("trigger.notify", { name: "dip" }), "x")
    await t.n.flush()
    expect(t.spawned).toHaveLength(0)
    // A view still gets it: it rings, or sends the terminal's own.
    const v = notifier({ settings: { mode, on: DEFAULT_NOTIFY.on }, target: "view-1" })
    v.n.row(row("trigger.notify", { name: "dip" }), "x")
    await v.n.flush()
    expect(v.published).toHaveLength(1)
  }
})

test("a machine that can't show one (a VPS, SSH) shows nothing; a failure is journalled once", async () => {
  const remote = notifier({ native: false })
  remote.n.row(row("trigger.notify", { name: "dip" }), "x")
  await remote.n.flush()
  expect(remote.spawned).toHaveLength(0)
  const failing = notifier({ spawn: async () => ({ exitCode: 1, stderr: "Cannot spawn a message bus\nmore" }) })
  for (let i = 0; i < 3; i++) {
    failing.n.row(row("trigger.notify", { name: "dip" }), "x")
    await failing.n.flush()
  }
  expect(failing.journal).toEqual([{ type: "notify.failed", by: "core", via: "osascript", exitCode: 1, error: "Cannot spawn a message bus" }])
  const throwing = notifier({ spawn: async () => Promise.reject(new Error("ENOENT: osascript")) })
  throwing.n.row(row("trigger.notify", { name: "dip" }), "x")
  await throwing.n.flush()
  expect(throwing.journal).toEqual([{ type: "notify.failed", by: "core", via: "osascript", exitCode: -1, error: "ENOENT: osascript" }])
})

test("stopping sends what's queued, then nothing", async () => {
  const t = notifier()
  t.n.row(row("trigger.notify", { name: "dip" }), "x")
  await t.n.stop()
  expect(t.spawned).toHaveLength(1)
  t.n.row(row("trigger.notify", { name: "dip" }), "y")
  await t.n.flush()
  expect(t.spawned).toHaveLength(1)
})

test("a bot's rows: its fills, its card waiting, an entry or exit that ended with nothing, a held sell and Candle's pause; never its skips", () => {
  const conf = (opId: string) => (opId === "x1" ? { bot: { name: "conf", act: "exit", reason: "stop_loss", token: "MOON" } } : { bot: { name: "conf", act: "entry", token: "BONK" } })
  expect(rowNotice(row("operation.succeeded", { opId: "e1" }), 'filled BUY $2.00 of BONK · by the bot "conf"', conf)).toEqual({ kind: "bots", words: 'filled BUY $2.00 of BONK · by the bot "conf"', bot: { bot: "conf", verb: "bought", token: "BONK" } })
  expect(rowNotice(row("operation.succeeded", { opId: "x1" }), "filled", conf)?.bot).toEqual({ bot: "conf", verb: "stopped out of", token: "MOON" })
  // How one ended with nothing is its bot row's to say, once.
  expect(rowNotice(row("operation.failed", { opId: "e1" }), "failed", conf)).toBeUndefined()
  expect(rowNotice(row("paper.call", { bot: "conf", botAct: "exit", botReason: "take_profit", args: { mint: "MoonFake11111111111111111111111111111111111" }, isError: false }), undefined, none, () => "MOON")?.bot).toEqual({ bot: "conf", verb: "took profit on", token: "MOON", paper: true })
  expect(rowNotice(row("bot.waiting", { name: "conf", cardId: "w1", words: "its buy of $2.00 of WIF waits for you" }), undefined, none)).toEqual({ kind: "bots", words: 'the bot "conf": its buy of $2.00 of WIF waits for you', cardId: "w1" })
  expect(rowNotice(row("bot.entry_ended", { name: "conf", outcome: "refused", words: "WIF: refused" }), undefined, none)?.kind).toBe("bots")
  expect(rowNotice(row("bot.exit_ended", { name: "conf", outcome: "rejected", words: "you rejected it" }), undefined, none)).toBeUndefined()
  expect(rowNotice(row("bot.exit_held", { name: "conf", why: "failed_sells", words: "MOON: its exit waits" }), undefined, none)).toEqual({ kind: "bots", words: `the bot "conf"'s sell waits: MOON: its exit waits` })
  expect(rowNotice(row("bot.exit_held", { name: "conf", why: "unread", words: "MOON: read again in a minute" }), undefined, none)).toBeUndefined()
  expect(rowNotice(row("bot.paused", { name: "conf", how: "candle" }), undefined, none)?.kind).toBe("bots")
  expect(rowNotice(row("bot.skipped", { name: "conf", count: 4 }), "skipped", none)).toBeUndefined()
})

test("a bot's trades that come together are one line a bot, naming each token and paper; [notify] on without bots tells none", async () => {
  const origins: Record<string, { bot: { name: string; act: string; reason?: string; token: string; paper?: boolean } }> = {
    e1: { bot: { name: "conf", act: "entry", token: "BONK" } },
    e2: { bot: { name: "conf", act: "entry", token: "WIF" } },
    x1: { bot: { name: "conf", act: "exit", reason: "stop_loss", token: "MOON" } },
    p1: { bot: { name: "dip", act: "entry", token: "JUP", paper: true } },
  }
  const spawned: string[][] = []
  const make = (on: NotifySettings["on"]) =>
    new CoreNotifier({ settings: { mode: "auto", on }, now: () => 0, target: () => undefined, publish: () => {}, waiting: () => true, origin: (opId) => origins[opId], native: true, platform: "darwin", spawn: async (argv) => (spawned.push(argv), { exitCode: 0, stderr: "" }), journal: { append: async () => {} }, quietMs: 20, maxWaitMs: 60 })
  const n = make(DEFAULT_NOTIFY.on)
  for (const id of ["e1", "e2", "p1", "x1"]) n.row(row("operation.succeeded", { opId: id }), `filled ${id}`)
  await n.flush()
  expect(spawned.map((a) => a.slice(-2))).toEqual([["Candle Harness · bot · 2 updates", "conf · bought BONK, WIF · stopped out of MOON · dip (paper) · bought JUP"]])
  const off = make(DEFAULT_NOTIFY.on.filter((k) => k !== "bots"))
  off.row(row("operation.succeeded", { opId: "e1" }), "filled")
  await off.flush()
  expect(spawned).toHaveLength(1)
})

test("a busy bot is told at most once in 5 minutes, its trades since in one line; a stop-loss goes at once, with what waited", async () => {
  const origins: Record<string, { bot: { name: string; act: string; reason?: string; token: string; paper?: boolean } }> = {
    e1: { bot: { name: "conf", act: "entry", token: "BONK" } },
    e2: { bot: { name: "conf", act: "entry", token: "WIF" } },
    e3: { bot: { name: "conf", act: "entry", token: "JUP" } },
    t1: { bot: { name: "conf", act: "exit", reason: "take_profit", token: "BONK" } },
    x1: { bot: { name: "conf", act: "exit", reason: "stop_loss", token: "WIF" } },
    d1: { bot: { name: "dip", act: "entry", token: "MOON" } },
  }
  const spawned: string[][] = []
  let now = 0
  const n = new CoreNotifier({ settings: DEFAULT_NOTIFY, now: () => now, target: () => undefined, publish: () => {}, waiting: () => true, origin: (opId) => origins[opId], native: true, platform: "darwin", spawn: async (argv) => (spawned.push(argv), { exitCode: 0, stderr: "" }), journal: { append: async () => {} }, quietMs: 10, maxWaitMs: 20, botFoldMs: 200 })
  const lines = () => spawned.map((a) => a.at(-1))
  n.row(row("operation.succeeded", { opId: "e1" }), "filled")
  await Bun.sleep(40)
  expect(lines()).toEqual(["conf · bought BONK"])
  // Inside its 5 minutes: conf's next trades wait; another bot is told as before.
  now = 50
  n.row(row("operation.succeeded", { opId: "e2" }), "filled")
  n.row(row("operation.succeeded", { opId: "t1" }), "filled")
  n.row(row("operation.succeeded", { opId: "d1" }), "filled")
  await Bun.sleep(40)
  expect(lines()).toEqual(["conf · bought BONK", "dip · bought MOON"])
  // A stop-loss goes at once, carrying what waited.
  now = 100
  n.row(row("operation.succeeded", { opId: "x1" }), "filled")
  await Bun.sleep(40)
  expect(lines().at(-1)).toBe("conf · bought WIF · took profit on BONK · stopped out of WIF")
  // Then the window starts again: the next entry waits for it, and goes when it's up.
  now = 150
  n.row(row("operation.succeeded", { opId: "e3" }), "filled")
  await Bun.sleep(40)
  expect(spawned).toHaveLength(3)
  await Bun.sleep(250)
  expect(lines().at(-1)).toBe("conf · bought JUP")
  // A failed sell isn't a trade: told at once whatever the window.
  now = 400
  n.row(row("bot.exit_ended", { name: "conf", outcome: "failed", words: "MOON: its sell didn't go through" }), undefined)
  await Bun.sleep(40)
  expect(spawned).toHaveLength(5)
})

test("a code bot's rows: its fills, a swap, its card waiting, a request that ended with nothing, a crash and giving up; never a start or what it says", () => {
  const grid = (opId: string) => (opId === "s1" ? { bot: { name: "grid", act: "exit", reason: "bot", token: "MOON" } } : opId === "w1" ? { bot: { name: "grid", act: "swap", token: "0.1 SOL to USDC" } } : { bot: { name: "grid", act: "entry", token: "BONK" } })
  expect(rowNotice(row("operation.succeeded", { opId: "b1" }), "filled", grid)?.bot).toEqual({ bot: "grid", verb: "bought", token: "BONK" })
  expect(rowNotice(row("operation.succeeded", { opId: "s1" }), "filled", grid)?.bot).toEqual({ bot: "grid", verb: "sold", token: "MOON" })
  expect(rowNotice(row("operation.succeeded", { opId: "w1" }), "filled", grid)?.bot).toEqual({ bot: "grid", verb: "swapped", token: "0.1 SOL to USDC" })
  expect(rowNotice(row("bot.request_waiting", { kind: "code", name: "grid", request: "r2", cardId: "c2", words: "its buy of $1.00 of WIF waits for you" }), undefined, none)).toEqual({ kind: "bots", words: 'the bot "grid": its buy of $1.00 of WIF waits for you', cardId: "c2" })
  expect(rowNotice(row("bot.request_ended", { kind: "code", name: "grid", request: "r3", outcome: "lost", words: "WIF: the core stopped before it was sent" }), undefined, none)?.kind).toBe("bots")
  expect(rowNotice(row("bot.request_ended", { kind: "code", name: "grid", request: "r4", outcome: "rejected", words: "you rejected it" }), undefined, none)).toBeUndefined()
  expect(rowNotice(row("bot.process", { kind: "code", name: "grid", what: "crashed", words: "crashed (exit 1)" }), undefined, none)?.kind).toBe("bots")
  expect(rowNotice(row("bot.process", { kind: "code", name: "grid", what: "gave_up", words: "gave up" }), undefined, none)?.kind).toBe("bots")
  expect(rowNotice(row("bot.process", { kind: "code", name: "grid", what: "started" }), undefined, none)).toBeUndefined()
  expect(rowNotice(row("bot.event", { kind: "code", name: "grid", word: "needs-a-look", text: "spread" }), undefined, none)).toBeUndefined()
})
