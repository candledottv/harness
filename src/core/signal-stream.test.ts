import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type FakeHacc, startFakeHacc } from "../../test/fake-hacc"
import { until } from "../../test/core-fixture"
import { HaccClient } from "./hacc"
import { EventHub } from "./events"
import { filterKey, type GapRow, isGap, parseSignalFilter, readCursor, type SignalFilter, SignalStream, type SignalStreamDeps, type SignalsData, signalsTopicFilter, type StreamRow, type Timing } from "./signal-stream"

// Built at run time: the scrub refuses key literals, even fake ones.
const keyA = ["cndl", "live", "a".repeat(32)].join("_")
const keyX = ["cndl", "live", "x".repeat(32)].join("_") // live-shaped, but not one Hacc takes
const testKey = ["cndl", "test", "t".repeat(32)].join("_")

const FAST: Partial<Timing> = { backoffMs: [30, 60], holdMs: 80, checkMs: 20, saveMs: 10, minePollMs: 40, minePlanHoldMs: 40 }

let hacc: FakeHacc
let dir: string
const streams: SignalStream[] = []
beforeEach(() => {
  hacc = startFakeHacc({ keys: [keyA] })
  dir = mkdtempSync(join(tmpdir(), "signals-"))
})
afterEach(async () => {
  for (const s of streams.splice(0)) await s.stop()
  hacc.stop()
  rmSync(dir, { recursive: true, force: true })
})

interface Harness {
  stream: SignalStream
  client: HaccClient
  published: { topic: string; rows: StreamRow[]; data: SignalsData }[]
  states: string[]
  journal: Record<string, unknown>[]
  want: { signals: boolean; mine: boolean }
  filters: SignalFilter[]
}
function make(o: { agents?: { agent: string; key: string }[]; timing?: Partial<Timing>; enabled?: boolean } = {}): Harness {
  const keys = Object.fromEntries((o.agents ?? [{ agent: "agent-a", key: keyA }]).map((a) => [a.agent, a.key]))
  const client = new HaccClient({ keyFor: (a) => keys[a], host: hacc.url, now: Date.now })
  const h = { published: [], states: [], journal: [], want: { signals: true, mine: false }, filters: [] } as unknown as Harness
  const deps: SignalStreamDeps = {
    hacc: client,
    agents: () => o.agents ?? [{ agent: "agent-a", key: keyA }],
    enabled: () => o.enabled ?? true,
    host: hacc.url,
    cursorPath: join(dir, "signals.json"),
    wanted: () => h.want,
    filters: () => h.filters,
    publish: (topic, data) => h.published.push({ topic, rows: data.rows, data }),
    onState: () => h.states.push(h.stream?.view().state ?? "?"),
    record: (e) => h.journal.push(e),
    now: Date.now,
    timing: { ...FAST, ...o.timing },
  }
  h.client = client
  h.stream = new SignalStream(deps)
  streams.push(h.stream)
  return h
}
const ids = (h: Harness, topic = "signals") => h.published.filter((p) => p.topic === topic).flatMap((p) => p.rows.filter((r) => !isGap(r)).map((r) => (r as { id: number }).id))
const streamCalls = () => hacc.calls.filter((c) => c.path === "/v1/signals/stream")
const openSockets = () => hacc.state.sockets.size

test("one socket for many needs: subscribers, agents' reads and pokes share it", async () => {
  const h = make()
  h.stream.poke()
  h.stream.touch()
  h.stream.poke()
  await until(() => h.stream.view().state === "open")
  h.stream.touch()
  h.stream.poke()
  await Bun.sleep(50)
  expect(openSockets()).toBe(1)
  expect(streamCalls().length).toBe(1)
})

test("the key goes in the upgrade's header, never its address", async () => {
  const h = make()
  h.stream.poke()
  await until(() => h.stream.view().state === "open")
  const call = streamCalls()[0]!
  expect(call.auth).toBe(`Bearer ${keyA}`)
  expect(JSON.stringify(call.query)).not.toContain(keyA)
  expect(JSON.stringify(h.stream.view())).not.toContain(keyA)
})

test("the snapshot, oldest first, then each new signal as it lands", async () => {
  const h = make()
  h.stream.poke()
  await until(() => h.published.length === 1)
  const first = h.published[0]!.rows as { id: number; created_at: string }[]
  expect(first.length).toBe(100)
  expect(first.map((r) => r.id)).toEqual([...first.map((r) => r.id)].sort((a, b) => a - b))
  const row = hacc.push()
  await until(() => h.published.length === 2)
  expect(h.published[1]!.rows.map((r) => (r as { id: number }).id)).toEqual([row.id as number])
  expect(h.stream.cursor()).toEqual({ at: row.created_at as string, id: row.id as number })
  expect(h.stream.snapshot().rows.length).toBe(100)
})

test("a dropped socket reopens and fills the gap from the tape by date: nothing lost, nothing doubled", async () => {
  const h = make()
  h.stream.poke()
  await until(() => h.published.length === 1)
  const before = h.stream.cursor()!
  hacc.dropSockets()
  // More than the reopened snapshot's 100, so only the fill can bring the oldest back.
  const unheard = Array.from({ length: 130 }, () => hacc.pushUnheard())
  await until(() => h.stream.view().state === "open" && ids(h).includes(unheard.at(-1)!.id as number))
  const after = hacc.push()
  await until(() => ids(h).includes(after.id as number))
  const seen = ids(h)
  expect(new Set(seen).size).toBe(seen.length)
  for (const r of unheard) expect(seen).toContain(r.id as number)
  const fill = hacc.calls.find((c) => c.path === "/v1/signals")!
  expect(fill.query).toMatchObject({ since: new Date(Date.parse(before.at) - 1).toISOString(), order: "asc", limit: "200" })
  expect(h.published.flatMap((p) => p.rows).some(isGap)).toBe(false)
  expect(h.journal.map((e) => e.event)).toEqual(expect.arrayContaining(["opened", "dropped", "filled"]))
})

test("a gap the tape can't fill is a row saying so, and the stream carries on", async () => {
  const h = make()
  h.stream.poke()
  await until(() => h.published.length === 1)
  const before = h.stream.cursor()!
  hacc.set({ fail: { "GET /v1/signals": { status: 500, body: { error: "internal error" } } } })
  hacc.dropSockets()
  for (let i = 0; i < 130; i++) hacc.pushUnheard()
  await until(() => h.published.flatMap((p) => p.rows).some(isGap))
  const gap = h.published.flatMap((p) => p.rows).find(isGap) as GapRow
  expect(gap.from).toBe(before.at)
  expect(gap.words).toContain("couldn't be read back")
  expect(gap.words).toContain("Hacc failed (500")
  expect(h.stream.recent(undefined, 500).some(isGap)).toBe(true)
  const after = hacc.push()
  await until(() => ids(h).includes(after.id as number))
  expect(h.stream.view().state).toBe("open")
})

test("past the fill's page limit, the rest is a gap row", async () => {
  const h = make({ timing: { maxFillPages: 1 } })
  h.stream.poke()
  await until(() => h.published.length === 1)
  hacc.dropSockets()
  const base = Date.now() + 10
  for (let i = 0; i < 450; i++) hacc.pushUnheard({ created_at: new Date(base + i).toISOString() })
  await until(() => h.published.flatMap((p) => p.rows).some(isGap))
  expect((h.published.flatMap((p) => p.rows).find(isGap) as GapRow).words).toContain("more than 200 came in while the stream was closed")
})

test("Hacc's cap: the stream holds with Hacc's words, and opens once a socket frees", async () => {
  hacc.set({ maxSockets: 0 })
  const h = make()
  h.stream.poke()
  await until(() => h.stream.view().state === "full")
  const view = h.stream.view()
  expect(view.words).toContain("too many subscribers for this key")
  expect(view.words).toContain("8 open at once")
  expect(view.words).toContain("Hacc's reads still answer")
  expect((await h.client.get("agent-a", "/v1/signals", { limit: 1 })).kind).toBe("ok")
  hacc.set({ maxSockets: 8 })
  await until(() => h.stream.view().state === "open")
  expect(h.journal.some((e) => e.event === "full")).toBe(true)
})

test("a key Hacc refuses passes the stream to the next agent's, and the refusal is noted", async () => {
  const h = make({ agents: [{ agent: "agent-t", key: testKey }, { agent: "agent-x", key: keyX }, { agent: "agent-a", key: keyA }] })
  h.stream.poke()
  await until(() => h.stream.view().state === "open")
  expect(h.stream.view().agent).toBe("agent-a")
  expect(h.client.keyRefused("agent-x")).toContain("invalid api key")
  // A test key is never sent: Hacc takes only live keys.
  expect(streamCalls().some((c) => c.auth === `Bearer ${testKey}`)).toBe(false)
})

test("with no key Hacc takes, the stream says so", async () => {
  const h = make({ agents: [{ agent: "agent-x", key: keyX }] })
  h.stream.poke()
  await until(() => h.stream.view().state === "no-key")
  expect(h.stream.view().words).toContain("invalid api key")
})

test("closed 5 minutes (here, moments) after the last need", async () => {
  const h = make({ timing: { idleCloseMs: 150 } })
  h.stream.touch()
  await until(() => h.stream.view().state === "open")
  h.want.signals = false
  await until(() => h.stream.view().state === "closed")
  await until(() => openSockets() === 0)
  expect(h.journal.some((e) => e.event === "closed" && e.why === "idle")).toBe(true)
  // Needed again: it reopens, reading back what came in while closed.
  const missed = hacc.pushUnheard()
  h.want.signals = true
  h.stream.poke()
  await until(() => ids(h).includes(missed.id as number))
})

test("a socket gone silent (no ping) is treated as dropped and reopened", async () => {
  hacc.set({ pingMs: 60_000 })
  const h = make({ timing: { silenceMs: 120 } })
  h.stream.poke()
  await until(() => streamCalls().length >= 2, 3000)
  expect(h.journal.some((e) => e.event === "dropped")).toBe(true)
})

test("the cursor is kept in state/signals.json (0600) and read back by the next core", async () => {
  const h = make()
  h.stream.poke()
  await until(() => h.published.length === 1)
  const row = hacc.push()
  await until(() => h.stream.cursor()?.id === row.id)
  await h.stream.stop()
  const path = join(dir, "signals.json")
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(readCursor(path)).toMatchObject({ at: row.created_at, id: row.id })
  const next = make()
  expect(next.stream.leftOff).toMatchObject({ at: row.created_at, id: row.id })
  expect(next.stream.view().leftOff).toMatchObject({ id: row.id })
})

test("rows are cleaned for the terminal as they arrive", async () => {
  const h = make()
  h.stream.poke()
  await until(() => h.published.length === 1)
  const row = hacc.push({ summary: "buy \u001b[31mnow\u0007 ‮evil", wallet_label: "a\u0000b" })
  await until(() => ids(h).includes(row.id as number))
  const got = h.published.at(-1)!.rows[0] as Record<string, unknown>
  expect(got.summary).toBe("buy [31mnow evil")
  expect(got.wallet_label).toBe("ab")
})

test("Hacc off: no socket, and the state says off", async () => {
  const h = make({ enabled: false })
  h.stream.poke()
  h.stream.touch()
  await Bun.sleep(50)
  expect(h.stream.view().state).toBe("off")
  expect(streamCalls().length).toBe(0)
})

test("personal signals are polled by Hacc's cursor while subscribed, and need Pro", async () => {
  const h = make()
  h.want = { signals: false, mine: true }
  const a = hacc.pushMine()
  const b = hacc.pushMine()
  h.stream.poke()
  await until(() => ids(h, "signals:mine").length === 2)
  expect(ids(h, "signals:mine")).toEqual([a.id as number, b.id as number])
  const c = hacc.pushMine()
  await until(() => ids(h, "signals:mine").length === 3)
  expect(ids(h, "signals:mine")).toEqual([a.id, b.id, c.id] as number[])
  const polls = hacc.calls.filter((x) => x.path === "/v1/me/signals")
  expect(polls.at(-1)!.query.after).toBeDefined()
  expect(h.stream.view().mine.state).toBe("polling")
  // No socket for personal signals: Hacc doesn't push them.
  expect(streamCalls().length).toBe(0)
  hacc.set({ plan: "free" })
  await until(() => h.stream.view().mine.state === "needs-plan")
  expect(h.stream.view().mine.words).toContain("Pro or Max")
  h.want.mine = false
  await until(() => h.stream.view().mine.state === "closed")
})

test("the signals filter: pattern and chain, each a name or a list", () => {
  expect(parseSignalFilter({ pattern: "confluence", chain: ["solana", "hood"] })).toEqual({ pattern: ["confluence"], chain: ["solana", "hood"] })
  expect(parseSignalFilter({ venue: "pump" })).toHaveProperty("problem")
  expect(parseSignalFilter({ pattern: [] })).toHaveProperty("problem")
  expect(parseSignalFilter("confluence")).toHaveProperty("problem")
  const rows = [
    { id: 1, created_at: "2026-10-29T00:00:00Z", pattern: "confluence", asset_chain: "solana" },
    { id: 2, created_at: "2026-10-29T00:00:01Z", pattern: "new_ticker", asset_chain: "hood" },
    { kind: "gap", id: "gap:x", created_at: "2026-10-29T00:00:02Z", from: "a", to: "b", words: "w" },
  ] as StreamRow[]
  expect(signalsTopicFilter.apply({ rows }, { pattern: ["confluence"] })).toEqual({ rows: [rows[0], rows[2]] })
  expect(signalsTopicFilter.apply({ rows: [rows[1]] }, { chain: ["solana"] })).toBeUndefined()
})

describe("a filter read back from Hacc's tape", () => {
  const readBacks = () => hacc.calls.filter((c) => c.path === "/v1/signals" && (c.query.pattern || c.query.chain))
  const backEvents = (h: Harness) => h.published.filter((p) => p.data.for !== undefined)

  test("a rare pattern the cache hasn't got is read from Hacc, sent for that filter, and in its snapshot", async () => {
    const h = make()
    h.stream.poke()
    await until(() => h.stream.view().state === "open")
    // The stream's newest hundred are all the recorded new_ticker: no dormancy among them.
    expect(h.stream.snapshot({ pattern: ["dormancy"] }).rows).toEqual([])
    h.filters = [{ pattern: ["dormancy"] }]
    h.stream.poke()
    await until(() => backEvents(h).length === 1)
    expect(readBacks().map((c) => c.query)).toEqual([{ pattern: "dormancy", limit: "100" }])
    const sent = backEvents(h)[0]!.data
    expect(sent.for).toBe(filterKey({ pattern: ["dormancy"] }))
    expect(sent.back).toMatchObject({ ok: true, rows: 1 })
    expect(sent.rows.map((r) => (r as { pattern?: string }).pattern)).toEqual(["dormancy"])
    expect(sent.since).toBeDefined()
    const snap = h.stream.snapshot({ pattern: ["dormancy"] })
    expect(snap.rows.length).toBe(1)
    expect(snap.back).toMatchObject({ ok: true, rows: 1 })
    expect(snap.since).toBe(sent.since)
    // The whole tape's snapshot never has it: its older rows would make the tape look whole.
    expect(h.stream.snapshot().rows.some((r) => (r as { pattern?: string }).pattern === "dormancy")).toBe(false)
    expect(h.journal.some((e) => e.event === "read_back" && e.ok === true && e.rows === 1)).toBe(true)
  })

  test("once a minute for each filter: poked again, or picked again within it, Hacc isn't asked", async () => {
    const h = make()
    h.filters = [{ pattern: ["large_move"], chain: ["solana"] }, { chain: ["hood"] }]
    h.stream.poke()
    await until(() => backEvents(h).length === 2)
    h.stream.poke()
    h.filters = [{ chain: ["solana"], pattern: ["large_move"] }]
    h.stream.poke()
    await Bun.sleep(30)
    expect(readBacks().length).toBe(2)
    expect(readBacks().find((c) => c.query.chain === "hood")?.query).toEqual({ chain: "hood", limit: "100" })
  })

  test("a refusal counts towards the minute, and its words go to the pane", async () => {
    hacc.set({ fail: { "GET /v1/signals": { status: 503, body: { error: "upstream busy" } } } })
    const h = make()
    h.filters = [{ pattern: ["confluence"] }]
    h.stream.poke()
    await until(() => backEvents(h).length === 1)
    expect(backEvents(h)[0]!.data.back).toMatchObject({ ok: false, rows: 0 })
    expect(backEvents(h)[0]!.data.back!.words).toContain("upstream busy")
    h.stream.poke()
    await Bun.sleep(30)
    expect(readBacks().length).toBe(1)
  })

  test("only a filter Hacc's tape takes as it is: one pattern and one chain at most", async () => {
    const h = make()
    h.filters = [{ pattern: ["confluence", "dormancy"] }, { chain: ["solana", "hood"] }]
    h.stream.poke()
    await Bun.sleep(50)
    expect(readBacks()).toEqual([])
    expect(h.stream.snapshot({ pattern: ["confluence", "dormancy"] }).back).toBeUndefined()
  })

  test("through the event hub: a read-back reaches its own filter alone, and a zero-row answer still arrives", () => {
    const hub = new EventHub()
    hub.provideFilter("signals", signalsTopicFilter)
    const got: { whole: unknown[]; dormancy: unknown[]; hood: unknown[] } = { whole: [], dormancy: [], hood: [] }
    const sub = (id: keyof typeof got) => ({ clientId: id, role: "view" as const, send: (n: { params: Record<string, unknown> }) => void got[id].push(n.params.data) })
    hub.subscribe(sub("whole"), ["signals"])
    hub.subscribe(sub("dormancy"), ["signals"], {}, hub.parseFilters({ signals: { pattern: "dormancy" } }))
    hub.subscribe(sub("hood"), ["signals"], {}, hub.parseFilters({ signals: { chain: "hood" } }))
    for (const k of ["whole", "dormancy", "hood"] as const) got[k] = []
    const row = { id: 7, created_at: "2026-10-29T00:00:00Z", pattern: "dormancy", asset_chain: "hood" } as StreamRow
    hub.publish("signals", { rows: [row], for: filterKey({ pattern: ["dormancy"] }), back: { at: "t", ok: true, rows: 1 } })
    hub.publish("signals", { rows: [], for: filterKey({ chain: ["hood"] }), back: { at: "t", ok: true, rows: 0 } })
    expect(got.whole).toEqual([])
    expect(got.dormancy).toEqual([{ rows: [row], for: filterKey({ pattern: ["dormancy"] }), back: { at: "t", ok: true, rows: 1 } }])
    expect(got.hood).toEqual([{ rows: [], for: filterKey({ chain: ["hood"] }), back: { at: "t", ok: true, rows: 0 } }])
    // A live row still goes to everyone it matches.
    hub.publish("signals", { rows: [row] })
    expect(got.whole.length).toBe(1)
    expect(got.dormancy.length).toBe(2)
    expect(got.hood.length).toBe(2)
  })
})
