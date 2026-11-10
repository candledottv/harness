// The firing path on its own: `it` put in as the token that fired, a part refused before anything ran said
// once, the kill switch's hold said as held, a waiting card said with why, a wake said where nothing wakes yet,
// and `run it now` refused for a card that can't run again.
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Redactor } from "../shared/redact"
import { refused } from "../shared/rpc"
import type { ChainOperation } from "../shared/chain"
import { resolveTrigger } from "../shared/trigger-grammar"
import { Journal } from "./journal"
import type { FaceClient } from "./tool-face"
import { type FiringCard, type TriggerNotice, TriggerFirer } from "./trigger-fire"
import type { TriggerEntry } from "./triggers-file"

const MOON = "MoonFake11111111111111111111111111111111111"
const JUP = "JupFake111111111111111111111111111111111111"
const dirs: string[] = []
const journals: Journal[] = []
afterEach(async () => {
  for (const j of journals.splice(0)) await j.close().catch(() => {})
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function rig(opts: { refuse?: (args: Record<string, unknown>) => { code: string; message: string } | undefined; waits?: boolean; wake?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "chrn-fire-"))
  dirs.push(dir)
  const journal = await Journal.open({ path: join(dir, "journal.jsonl"), redactor: new Redactor(), account: "acct_fake", now: () => Date.now() })
  journals.push(journal)
  const cards = new Map<string, FiringCard>()
  const ops = new Map<string, ChainOperation>()
  const sent: { args: Record<string, unknown>; client: FaceClient }[] = []
  const notices: TriggerNotice[] = []
  const entries = new Map<string, TriggerEntry>()
  const resolved = (t: TriggerEntry) => {
    const r = resolveTrigger(t.expansion, { agents: ["momentum"], knownTokens: new Map(), mode: "live", proposer: t.agent })
    return r.ok ? r.value : undefined
  }
  const firer = new TriggerFirer({
    book: { resolved, entry: (name) => entries.get(name), gate: () => ({ state: "ok" }), modeOf: (t) => t.mode ?? "live" },
    journal,
    send: async (part, client) => {
      const why = opts.refuse?.(part.args)
      if (why) throw refused(why.code, why.message)
      sent.push({ args: part.args, client })
      const n = sent.length
      const cardId = `c${n}`
      const waits = opts.waits === true
      cards.set(cardId, { cardId, opId: `op${n}`, agent: client.agent, state: waits ? "awaiting_approval" : "approved", display: { title: `BUY · ${n}`, headline: `BUY ${n}`, ...(waits ? { cardBecause: "over the embedded wallet's $2.00 a trade without a card: this one is $3.02" } : {}) }, origin: { ...(client.trigger ? { trigger: client.trigger } : {}) } })
      if (!waits) ops.set(`op${n}`, { state: "succeeded" })
      return { cardId, opId: `op${n}`, state: waits ? "awaiting_approval" : "approved", ...(waits ? {} : { instant: { kind: "submitted" } }) }
    },
    card: (id) => cards.get(id),
    operation: (id) => ops.get(id),
    paused: () => false,
    nameOf: (mint) => (mint === MOON ? "MOON" : undefined),
    notify: (n) => notices.push(n),
    ...(opts.wake ? { wake: async () => ({ kind: "woke" as const, turnId: "t_1", joined: false }) } : {}),
  })
  const entry = (name: string, line: string): TriggerEntry => {
    const r = resolveTrigger(line, { agents: ["momentum"], knownTokens: new Map(), mode: "live", proposer: "momentum" })
    if (!r.ok) throw new Error(r.message)
    const t: TriggerEntry = { name, agent: "momentum", line, expansion: r.value.expansion, on: true, again: false }
    entries.set(name, t)
    return t
  }
  const rowsOf = (type: string) => journal.rows().filter((r) => r.type === type)
  return { firer, journal, sent, notices, cards, ops, entry, rowsOf }
}

test("`it` is the token that fired: put into every part that names it, the trigger's origin on each", async () => {
  const r = await rig()
  const t = r.entry("tape", `when new_ticker mcap < 200k buy 0.01 sol of it; sell 100% of it`)
  const end = await r.firer.fire(t, { by: "tape", mint: MOON, chain: "solana", signalId: 7, pattern: "new_ticker", signalAt: new Date().toISOString() }, "fire_1")
  expect(end).toMatchObject({ kind: "ran", end: { kind: "done", sent: 2 } })
  expect(r.sent.map((s) => s.args.mint)).toEqual([MOON, MOON])
  expect(r.sent.map((s) => s.client)).toEqual([
    { clientId: "core:triggers", role: "core", agent: "momentum", trigger: { name: "tape", fireId: "fire_1", part: 0, mode: "live" } },
    { clientId: "core:triggers", role: "core", agent: "momentum", trigger: { name: "tape", fireId: "fire_1", part: 1, mode: "live" } },
  ])
  // A chain says how it ended.
  expect(r.rowsOf("trigger.ran")).toEqual([expect.objectContaining({ name: "tape", fireId: "fire_1", outcome: "done", sent: 2, parts: 2 })])
})

test("a firing goes in the trigger's own mode, on its client and its rows, whatever the Candle Harness's is", async () => {
  const r = await rig()
  const t = { ...r.entry("stop", `when ${MOON} < $0.40 sell 100% of ${MOON}`), mode: "paper" as const }
  await r.firer.fire(t, { by: "level", what: "price", mint: MOON, chain: "solana", reading: 0.39, level: 0.4, readAt: new Date().toISOString() }, "fire_p")
  expect(r.sent[0]!.client.trigger).toEqual({ name: "stop", fireId: "fire_p", part: 0, mode: "paper" })
  const wake = { ...r.entry("note", `when ${MOON} < $0.40 notify`), mode: "paper" as const }
  await r.firer.fire(wake, { by: "level", what: "price", mint: MOON, chain: "solana", reading: 0.39, level: 0.4, readAt: new Date().toISOString() }, "fire_n")
  expect(r.rowsOf("trigger.notify")[0]).toMatchObject({ name: "note", mode: "paper" })
})

test("`it` with no token from the firing: nothing runs, and it says why", async () => {
  const r = await rig()
  const t = r.entry("mine", `when mine buy 0.01 sol of it`)
  const end = await r.firer.fire(t, { by: "mine", signalId: 3, pattern: "kol_mention", signalAt: new Date().toISOString() }, "fire_2")
  expect(end).toEqual({ kind: "stopped", words: "it didn't say which token fired it, so nothing ran" })
  expect(r.sent).toHaveLength(0)
  expect(r.notices).toEqual([{ kind: "stopped", name: "mine", agent: "momentum", words: "it didn't say which token fired it, so nothing ran" }])
})

test("the kill switch's pause: said as held, notified, and the chain's next part never sent", async () => {
  const r = await rig({ refuse: (args) => (args.side === "buy" ? { code: "PAUSED", message: "Buys are paused by the kill switch. Nothing was sent." } : undefined) })
  const t = r.entry("round", `on call buy 0.01 sol of ${MOON}; sell 100% of ${MOON}`)
  const end = await r.firer.fire(t, { by: "call", clientId: "test" }, "fire_3")
  expect(end).toMatchObject({ kind: "ran", end: { kind: "stopped", sent: 0 } })
  expect(r.rowsOf("trigger.held")).toEqual([expect.objectContaining({ name: "round", fireId: "fire_3", part: 0, reason: "paused", words: "the kill switch holds its buy, so it wasn't sent" })])
  expect(r.notices.map((n) => n.kind)).toEqual(["held", "stopped"])
  expect(r.sent).toHaveLength(0)
})

test("a refusal that isn't the pause (the agent's limit) stops it, said once, with no held row", async () => {
  const r = await rig({ refuse: () => ({ code: "OVER_TRADE_LIMIT", message: "This is over momentum's $1.00 a trade. Nothing was sent." }) })
  const t = r.entry("dip", `on call buy 0.01 sol of ${MOON}`)
  await r.firer.fire(t, { by: "call", clientId: "test" }, "fire_4")
  expect(r.rowsOf("trigger.held")).toHaveLength(0)
  expect(r.rowsOf("trigger.ran")).toEqual([expect.objectContaining({ outcome: "stopped", sent: 0, words: expect.stringContaining("over momentum's $1.00 a trade") })])
})

test("a card that waits: said with why, notified with its card", async () => {
  const r = await rig({ waits: true })
  const t = r.entry("big", `on call buy 0.02 sol of ${MOON}`)
  void r.firer.fire(t, { by: "call", clientId: "test" }, "fire_5")
  for (let i = 0; i < 20 && !r.rowsOf("trigger.waiting").length; i++) await Bun.sleep(5)
  const row = r.rowsOf("trigger.waiting")[0]!
  expect(row).toMatchObject({ name: "big", cardId: "c1", part: 0, because: "over the embedded wallet's $2.00 a trade without a card: this one is $3.02" })
  expect(row.words).toBe("BUY 1 waits for you: over the embedded wallet's $2.00 a trade without a card: this one is $3.02")
  expect(r.notices).toEqual([{ kind: "waiting", name: "big", agent: "momentum", words: String(row.words), cardId: "c1" }])
  r.firer.stop("test")
})

test("a wake with nothing to wake yet is said, and nothing runs; with a waker, it's handed over", async () => {
  const r = await rig()
  const t = r.entry("look", `on call wake momentum "the tape"`)
  expect(await r.firer.fire(t, { by: "call", clientId: "test" }, "fire_6")).toEqual({ kind: "stopped", words: "waking momentum isn't in this core yet, so nothing ran" })
  const w = await rig({ wake: true })
  expect(await w.firer.fire(w.entry("look", `on call wake momentum`), { by: "call", clientId: "test" }, "fire_7")).toEqual({ kind: "woke", turnId: "t_1", joined: false })
})

test("notify with no words says what fired, and on which token", async () => {
  const r = await rig()
  const t = r.entry("ping", `when ${MOON} < $0.40 notify`)
  await r.firer.fire(t, { by: "level", what: "price", mint: MOON, chain: "solana", reading: 0.39, level: 0.4, readAt: new Date().toISOString() }, "fire_8")
  expect(r.rowsOf("trigger.notify")).toEqual([expect.objectContaining({ name: "ping", words: '"ping" fired on MOON' })])
  expect(r.sent).toHaveLength(0)
})

test("notify with the person's words names the token that fired it after them, so every notice doesn't read alike", async () => {
  const r = await rig()
  const t = r.entry("tape", `when new_ticker chain solana notify "New ticker on Solana"`)
  await r.firer.fire(t, { by: "tape", mint: MOON, chain: "solana", signalId: 1, pattern: "new_ticker", signalAt: new Date().toISOString() } as never, "fire_9")
  expect(r.rowsOf("trigger.notify")).toEqual([expect.objectContaining({ name: "tape", words: "New ticker on Solana · MOON" })])
})

test("run it now: refused for a card that isn't a trigger's, isn't expired, or whose trigger is gone; from the part that expired on", async () => {
  const r = await rig()
  const t = r.entry("round", `on call buy 0.01 sol of ${MOON}; sell 100% of ${JUP}`)
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code)
  expect(await code(r.firer.runNow({ cardId: "x", state: "expired" }, "view"))).toBe("NOT_A_TRIGGER_CARD")
  expect(await code(r.firer.runNow({ cardId: "x", state: "awaiting_approval", trigger: { name: "round", fireId: "f", part: 1 } }, "view"))).toBe("CARD_NOT_EXPIRED")
  expect(await code(r.firer.runNow({ cardId: "x", state: "expired", trigger: { name: "gone", fireId: "f", part: 0 } }, "view"))).toBe("UNKNOWN_TRIGGER")
  const ran = await r.firer.runNow({ cardId: "c9", state: "expired", trigger: { name: t.name, fireId: "f", part: 1 } }, "view")
  expect(ran.said).toBe('"round": its trade proposed again at a fresh price.')
  await ran.ended
  // Only the part that expired, and what followed it.
  expect(r.sent.map((s) => [s.args.side, s.args.mint, s.client.trigger?.part])).toEqual([["sell", JUP, 1]])
  expect(r.rowsOf("trigger.run_now")).toEqual([expect.objectContaining({ name: "round", from: "f", cardId: "c9", part: 1, by: "view" })])
})
