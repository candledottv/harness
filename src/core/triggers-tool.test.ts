// harness_triggers: what narrows a saved trigger (changed at once) and what widens it (a card the person presses);
// the card's own words, with the wallet of its own suggested where it asks each time, and a wake's caps; off
// at once, one or all, never back on by the agent; a woken turn reads and switches off, nothing more; Free
// proposes nothing; and an approved card saved, checked whole again, refused when its line reads differently now.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Redactor } from "../shared/redact"
import { ASK, type WalletSetting } from "./autonomy"
import { Journal } from "./journal"
import { AliasFile, LineReader } from "./line-reader"
import type { HaccPlan } from "./plan-state"
import { TokenNames } from "./token-names"
import type { FaceClient } from "./tool-face"
import { approvedHash, TriggerBook } from "./triggers"
import { TriggersFileStore } from "./triggers-file"
import { narrowing, readTriggerCard, runTriggerCard, type TriggerCardInput, type TriggerCardParams, TriggersTool } from "./triggers-tool"

const JUP = "JupFake111111111111111111111111111111111111"
const BONK = "BonkFake11111111111111111111111111111111111"
const T0 = new Date(2026, 10, 4, 12, 0, 0).getTime()
const INSIDE: WalletSetting = { setting: "inside", perTradeUsd: 2, perDayUsd: 10 }
const dirs: string[] = []
const journals: Journal[] = []
afterEach(async () => {
  for (const j of journals.splice(0)) await j.close().catch(() => {})
})
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

async function world(o: { plan?: HaccPlan; setting?: WalletSetting; woken?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "chrn-trigtool-"))
  dirs.push(dir)
  const journal = await Journal.open({ path: join(dir, "journal.jsonl"), redactor: new Redactor(), account: "acct_fake", now: () => T0 })
  journals.push(journal)
  const names = new TokenNames()
  names.learn("JUP", JUP)
  names.learn("BONK", BONK)
  const config = join(dir, "config.toml")
  writeFileSync(config, '[aliases]\nb5 = "buy $5 of"\n')
  const now = { mode: "live" as "paper" | "live", window: "24h" }
  const lines = new LineReader({ aliases: new AliasFile(config), names, agents: () => ["agent-a", "agent-b"], wallets: () => undefined, mode: () => now.mode })
  const setting = { value: o.setting ?? ASK }
  const book = new TriggerBook({
    file: new TriggersFileStore(join(dir, "triggers.toml")),
    statePath: join(dir, "triggers.json"),
    journal,
    lines,
    agents: () => ["agent-a", "agent-b"],
    plan: () => o.plan ?? "pro",
    mode: () => now.mode,
    pnlWindow: () => now.window,
    now: () => T0,
    payWallet: () => ({ address: "EmbedFake11111111111111111111111111111111111", name: "embedded", setting: setting.value }),
    feeBps: () => 100,
    onChange: () => {},
  })
  const proposed: { client: FaceClient; card: TriggerCardInput; reason?: string }[] = []
  const tool = new TriggersTool({
    book,
    propose: async (client, card, reason) => {
      proposed.push({ client, card, ...(reason ? { reason } : {}) })
      return `op_${proposed.length}`
    },
    wokenBy: (tokenId) => (tokenId === "woken" ? (o.woken ?? "dip") : undefined),
    caps: () => ({ perHour: 4, perDay: 24 }),
    ownWallet: (agent) => [{ label: `new TEE wallet for ${agent}`, line: "candle vault promote --to-key PREFIXxx --label agent-a-tee --from " }],
  })
  return { dir, config, journal, book, tool, proposed, setting, now }
}

const agentA: FaceClient = { clientId: "h1", role: "harness", agent: "agent-a", tokenId: "turn" }
const woken: FaceClient = { ...agentA, tokenId: "woken" }

/** Saves a line as its card's press would. */
async function save(book: TriggerBook, line: string, agent = "agent-a") {
  const c = book.check(line, agent)
  return book.save(line, agent, { expansion: c.trigger.expansion })
}

/** Whether `next` only narrows the saved `line`. */
async function narrows(line: string, next: string) {
  const { book } = await world()
  const { name } = await save(book, line)
  const t = book.entry(name)!
  // As the tool reads a change to a saved trigger: under its name, unless the line gives one.
  const n = narrowing(t, book.resolved(t)!, book.check(/ as "[^"]*"$/.test(next) ? next : `${next} as "${name}"`, "agent-a").trigger)
  return n.narrows ? n.what : false
}

describe("what narrows a trigger", () => {
  test("a smaller amount, a level harder to reach, more from the entry, fewer tokens through, a longer interval", async () => {
    expect(await narrows(`when ${JUP} < $0.50 buy $5 of ${JUP}`, `when ${JUP} < $0.50 buy $2 of ${JUP}`)).toEqual(["its amount, from $5 to $2"])
    expect(await narrows(`when ${JUP} > $1 buy $5 of ${JUP}`, `when ${JUP} > $1.20 buy $5 of ${JUP}`)).toEqual(["its level, from $1 to $1.20"])
    expect(await narrows(`when ${JUP} down 20% buy $5 of ${JUP}`, `when ${JUP} down 30% buy $5 of ${JUP}`)).toEqual(["its level, from down 20% to down 30%"])
    expect(await narrows(`when ${JUP} < $0.50 buy $5 of ${JUP}`, `when ${JUP} < $0.45 buy $2 of ${JUP}`)).toEqual(["its level, from $0.50 to $0.45", "its amount, from $5 to $2"])
    expect(await narrows("when confluence mcap < 500k notify", "when confluence mcap < 200k age < 60m notify")).toEqual(["its filters, which let fewer tokens through"])
    expect(await narrows(`every 4h buy $1 of ${JUP}`, `every 6h buy $1 of ${JUP}`)).toEqual(["its schedule, from every 4 hours to every 6 hours"])
    expect(await narrows("when mine notify", 'when mine "whales" notify as "mine"')).toEqual(['to the rule "whales" alone'])
  })

  test("for a trigger that sells, a smaller amount or a level harder to reach is wider, so a card", async () => {
    // A stop that sells less, or only further down, protects less: never changed at once.
    for (const [line, next] of [
      [`when ${JUP} < $0.40 sell 100% of ${JUP}`, `when ${JUP} < $0.01 sell 1% of ${JUP}`],
      [`when ${JUP} < $0.40 sell 50% of ${JUP}`, `when ${JUP} < $0.40 sell 25% of ${JUP}`],
      [`when ${JUP} < $0.40 sell 50% of ${JUP}`, `when ${JUP} < $0.35 sell 50% of ${JUP}`],
      [`when ${JUP} > $1 sell 50% of ${JUP}`, `when ${JUP} > $1.20 sell 50% of ${JUP}`],
      [`when ${JUP} down 20% sell 50% of ${JUP}`, `when ${JUP} down 30% sell 50% of ${JUP}`],
      [`when ${JUP} < $0.50 buy $5 of ${JUP}; sell 10% of ${BONK}`, `when ${JUP} < $0.50 buy $2 of ${JUP}; sell 10% of ${BONK}`],
    ]) {
      expect([next, await narrows(line!, next!)]).toEqual([next, false])
    }
  })

  test("a longer cooldown, and again dropped", async () => {
    expect(await narrows(`when ${JUP} > $1 sell 10% of ${JUP} again`, `when ${JUP} > $1 sell 10% of ${JUP} again cooldown 2h`)).toEqual(["its cooldown, from 30 minutes to 2 hours"])
    expect(await narrows(`when ${JUP} > $1 sell 10% of ${JUP} again`, `when ${JUP} > $1 sell 10% of ${JUP}`)).toEqual(["it fires once now, rather than again"])
  })

  test("anything else is no narrowing: wider, another token, wallet or action, again added, a shorter cooldown, a filter dropped, no change", async () => {
    const stop = `when ${JUP} < $0.40 sell 50% of ${JUP}`
    for (const next of [
      `when ${JUP} < $0.40 sell 75% of ${JUP}`,
      `when ${JUP} < $0.45 sell 50% of ${JUP}`,
      `when ${JUP} > $0.40 sell 50% of ${JUP}`,
      `when ${JUP} < $0.40 sell 50% of ${BONK}`,
      `when ${JUP} < $0.40 sell 50% of ${JUP} as agent-b`,
      `when ${JUP} < $0.40 notify`,
      `when ${JUP} < $0.40 sell 50% of ${JUP} again`,
      stop,
    ]) {
      expect([next, await narrows(stop, next)]).toEqual([next, false])
    }
    expect(await narrows(`when ${JUP} > $1 sell 10% of ${JUP} again cooldown 2h`, `when ${JUP} > $1 sell 10% of ${JUP} again cooldown 1h`)).toBe(false)
    expect(await narrows("when confluence mcap < 500k age < 60m notify", "when confluence mcap < 500k notify")).toBe(false)
    expect(await narrows(`when ${JUP} < $0.50 buy $5 of ${JUP}`, `when ${JUP} < $0.50 buy $5 of ${JUP}; sell 10% of ${JUP}`)).toBe(false)
  })
})

describe("harness_triggers", () => {
  test("read: every trigger in words, on or off, and how it runs now", async () => {
    const w = await world({ setting: INSIDE })
    await save(w.book, `when ${JUP} < $0.40 sell 50% of ${JUP} as "stop"`)
    await save(w.book, `when ${JUP} < $0.30 buy $5 of ${JUP} as "dip"`)
    const read = await w.tool.call(agentA, { action: "read" })
    const all = (read as unknown as { body: { triggers: { name: string; agent: string; on: boolean; armed: boolean; runs: string; words: string }[] } }).body.triggers
    expect(all.map((t) => [t.name, t.agent, t.on, t.armed]).sort()).toEqual([["dip", "agent-a", true, true], ["stop", "agent-a", true, true]])
    const stop = all.find((t) => t.name === "stop")
    const dip = all.find((t) => t.name === "dip")
    expect(stop!.words).toBe("When JUP's price falls below $0.40, sell 50% of JUP. Fires once, then switches off.")
    expect(stop!.runs).toStartWith("Runs on its own: the embedded wallet trades inside limits, and sells aren't limited.")
    expect(dip!.runs).toStartWith("Asks you each time: this buy, $5.05 with Candle's fee, is over the embedded wallet's $2.00 a trade")
  })

  test("propose: a card with the exact line, the trigger in words and how it runs; nothing saved before the press", async () => {
    const w = await world({ setting: INSIDE })
    const out = await w.tool.call(agentA, { action: "propose", line: `when JUP < $0.40 sell 50% of JUP` }, "the person's stop")
    expect(out).toEqual({ card: "op_1" })
    const { card, reason } = w.proposed[0]!
    expect(reason).toBe("the person's stop")
    expect(card.spec).toEqual({
      line: "when JUP < $0.40 sell 50% of JUP",
      words: "When JUP's price falls below $0.40, sell 50% of JUP. Fires once, then switches off.",
      runs: "Runs on its own: the embedded wallet trades inside limits, and sells aren't limited. Each firing trades with a receipt.",
      kind: "own",
      mode: "live",
    })
    expect(card.paysFrom).toBe("embedded")
    expect(card.warning).toBeUndefined()
    expect(card.fills).toBeUndefined()
    expect(card.check.trigger.expansion).toBe(`when ${JUP} < $0.40 sell 50% of ${JUP}`)
    expect(w.book.entries()).toEqual([])
  })

  test("one that asks each time says so in amber, and suggests a wallet of its own with the chip that starts it", async () => {
    const w = await world()
    await w.tool.call(agentA, { action: "propose", line: `every day 09:00 buy $5 of ${JUP}` })
    const { card } = w.proposed[0]!
    expect(card.spec.runs).toStartWith("Asks you each time: the embedded wallet asks every time")
    expect(card.warning).toBe(
      "The embedded wallet asks every time, so this will wait for you. For it to run on its own, give it a wallet of its own: a new TEE wallet just for this trigger, set to trade inside limits. Your wallets aren't changed.",
    )
    expect(card.fills).toEqual([{ label: "new TEE wallet for agent-a", line: "candle vault promote --to-key PREFIXxx --label agent-a-tee --from " }])
  })

  test("a wake says it wakes the agent, and its caps", async () => {
    const w = await world()
    await w.tool.call(agentA, { action: "propose", line: "when confluence mcap < 500k wake agent-b" })
    expect(w.proposed[0]!.card.spec.runs).toBe(
      "Wakes agent-b: its trades run as yours would, inside the wallet's figures with a receipt, over them as a card. It wakes at most 4 an hour and 24 a day; past either, the wake is skipped and said.",
    )
  })

  test("a name already saved: refused without replace; with it, a narrowing is changed at once and anything wider is a card", async () => {
    const w = await world()
    await save(w.book, `when ${JUP} < $0.40 buy $5 of ${JUP} as "stop"`)
    w.book.markFired("stop", T0 - 1000)
    const taken = await w.tool.call(agentA, { action: "propose", line: `when ${JUP} < $0.40 buy $2 of ${JUP} as "stop"` })
    expect(taken).toMatchObject({ ok: false, code: "NAME_TAKEN" })

    const narrowed = await w.tool.call(agentA, { action: "propose", line: `when ${JUP} < $0.35 buy $2 of ${JUP} as "stop"`, replace: true })
    expect(narrowed).toMatchObject({ ok: true, body: { success: true, done: 'Changed "stop" at once, since it only narrows it: its level, from $0.40 to $0.35; its amount, from $5 to $2.' } })
    expect(w.proposed).toHaveLength(0)
    const t = w.book.entry("stop")!
    expect(t).toMatchObject({ line: `when ${JUP} < $0.35 buy $2 of ${JUP}`, expansion: `when ${JUP} < $0.35 buy $2 of ${JUP}`, on: true })
    // Approved as the narrower line, so it runs; its last firing is kept.
    expect(w.book.stateOf("stop")).toMatchObject({ approved: approvedHash(t), on: true, lastFired: new Date(T0 - 1000).toISOString() })
    expect(w.book.heldBy(t)).toBeUndefined()
    expect(w.journal.rows().at(-1)).toMatchObject({ type: "trigger.changed", name: "stop", how: "agent", changedBy: "agent-a", narrowed: ["its level, from $0.40 to $0.35", "its amount, from $5 to $2"], on: true })

    const wider = await w.tool.call(agentA, { action: "propose", line: `when ${JUP} < $0.35 buy $10 of ${JUP} as "stop"`, replace: true })
    expect(wider).toEqual({ card: "op_1" })
    expect(w.proposed[0]!.card.spec.replaces).toBe(true)
    expect(w.book.entry("stop")!.line).toBe(`when ${JUP} < $0.35 buy $2 of ${JUP}`)
  })

  test("a change to a saved trigger goes by name: a line with none takes it, one named otherwise is refused", async () => {
    const w = await world()
    const { name } = await save(w.book, `when ${JUP} < $0.40 buy $5 of ${JUP}`)
    expect(name).toBe("JupF…1111 < $0.40")
    expect(await w.tool.call(agentA, { action: "propose", line: `when ${JUP} < $0.30 buy $5 of ${JUP}`, replace: true, name })).toMatchObject({ ok: true, body: { done: `Changed "${name}" at once, since it only narrows it: its level, from $0.40 to $0.30.` } })
    expect(w.book.entries().map((t) => [t.name, t.line])).toEqual([[name, `when ${JUP} < $0.30 buy $5 of ${JUP}`]])
    expect(await w.tool.call(agentA, { action: "propose", line: `when ${JUP} < $0.20 buy $5 of ${JUP} as "other"`, replace: true, name })).toMatchObject({ ok: false, code: "MCP_VALIDATION" })
  })

  test("a trigger changed by hand since it was approved is never narrowed at once: a card", async () => {
    const w = await world()
    await save(w.book, `when ${JUP} < $0.40 sell 50% of ${JUP} as "stop"`)
    const t = w.book.entry("stop")!
    new TriggersFileStore(join(w.dir, "triggers.toml")).write({ stop: { ...t, line: `when ${JUP} < $0.40 sell 90% of ${JUP}`, expansion: `when ${JUP} < $0.40 sell 90% of ${JUP}` } })
    expect(await w.tool.call(agentA, { action: "propose", line: `when ${JUP} < $0.40 sell 80% of ${JUP} as "stop"`, replace: true })).toEqual({ card: "op_1" })
  })

  test("off: one at once, or every one; already off is said; the agent never switches one back on", async () => {
    const w = await world()
    await save(w.book, `when ${JUP} < $0.40 sell 50% of ${JUP} as "stop"`)
    await save(w.book, `every day 09:00 buy $5 of ${JUP} as "morning"`)
    expect(await w.tool.call(agentA, { action: "off", name: "stop" })).toMatchObject({ ok: true, body: { done: '"stop" is off.' } })
    expect(w.journal.rows().at(-1)).toMatchObject({ type: "trigger.changed", name: "stop", on: false, how: "agent", changedBy: "agent-a" })
    expect(await w.tool.call(agentA, { action: "off", name: "stop" })).toMatchObject({ ok: true, body: { done: '"stop" was already off.' } })
    // The ones already off are said, and how: a schedule or a level switched off by hand never "switched itself off".
    expect(await w.tool.call(agentA, { action: "off", all: true })).toMatchObject({ ok: true, body: { done: '"morning" is off.', alreadyOff: 'Already off: "stop" was switched off (by the person or an agent; it doesn\'t switch itself off).' } })
    expect(w.book.entries().map((t) => w.book.isOn(t))).toEqual([false, false])
    expect(await w.tool.call(agentA, { action: "off", all: true })).toMatchObject({ ok: true, body: { done: "No trigger is on, so nothing changed." } })
    expect(await w.tool.call(agentA, { action: "off", name: "nope" })).toMatchObject({ ok: false, code: "UNKNOWN_TRIGGER" })
    await expect(w.book.set("stop", true, { clientId: "h1", main: false, how: "agent" })).rejects.toMatchObject({ code: "PERSON_ONLY" })
  })

  test("a woken turn may read and switch off, and nothing more", async () => {
    const w = await world()
    await save(w.book, `when ${JUP} < $0.40 sell 50% of ${JUP} as "stop"`)
    expect(await w.tool.call(woken, { action: "propose", line: `when ${JUP} < $0.30 sell 50% of ${JUP}` })).toMatchObject({ ok: false, code: "WOKEN_TURN" })
    expect(await w.tool.call(woken, { action: "propose", line: `when ${JUP} < $0.35 sell 25% of ${JUP} as "stop"`, replace: true })).toMatchObject({ ok: false, code: "WOKEN_TURN" })
    expect(w.book.entry("stop")!.line).toBe(`when ${JUP} < $0.40 sell 50% of ${JUP}`)
    expect(await w.tool.call(woken, { action: "read" })).toMatchObject({ ok: true })
    expect(await w.tool.call(woken, { action: "off", name: "stop" })).toMatchObject({ ok: true })
    expect(w.proposed).toHaveLength(0)
  })

  const agentB: FaceClient = { clientId: "h2", role: "harness", agent: "agent-b", tokenId: "turn" }
  const wokenB: FaceClient = { ...agentB, tokenId: "woken" }

  test("a woken turn switches off its own agent's triggers only: another agent's stop stays on, and is named", async () => {
    const w = await world()
    await save(w.book, `when ${JUP} < $0.40 sell 50% of ${JUP} as "stop"`)
    await save(w.book, `every day 09:00 buy $5 of ${JUP} as "morning"`, "agent-b")
    expect(await w.tool.call(wokenB, { action: "off", name: "stop" })).toMatchObject({ ok: false, code: "ANOTHER_AGENTS" })
    const all = (await w.tool.call(wokenB, { action: "off", all: true })) as { ok: true; body: Record<string, string> }
    expect(all.body.done).toBe('"morning" is off.')
    expect(all.body.leftOn).toStartWith('Left on, since it\'s another agent\'s and a trigger woke this turn: "stop" (agent-a).')
    expect(w.book.entries().map((t) => [t.name, w.book.isOn(t)])).toEqual([["morning", false], ["stop", true]])
    // With nothing of its own on, it says so, and still names what it left.
    expect(await w.tool.call(wokenB, { action: "off", all: true })).toMatchObject({ ok: true, body: { done: "No trigger of agent-b's is on, so nothing changed.", leftOn: expect.stringContaining('"stop" (agent-a)') } })
    expect(w.journal.rows().findLast((r) => r.type === "trigger.changed")).toMatchObject({ name: "morning", how: "agent", changedBy: "agent-b", woken: "dip" })
  })

  test("a turn the person started switches off any agent's: stop all my triggers means all", async () => {
    const w = await world()
    await save(w.book, `when ${JUP} < $0.40 sell 50% of ${JUP} as "stop"`)
    await save(w.book, `every day 09:00 buy $5 of ${JUP} as "morning"`, "agent-b")
    expect(await w.tool.call(agentB, { action: "off", all: true })).toMatchObject({ ok: true, body: { done: '"morning" is off. "stop" is off.' } })
    expect(w.book.entries().map((t) => w.book.isOn(t))).toEqual([false, false])
  })

  test("switching off a trigger that sells records what it sold, for the away note and the notice", async () => {
    const w = await world()
    await save(w.book, `when ${JUP} < $0.40 sell 50% of ${JUP} as "stop"`)
    await save(w.book, `when ${JUP} < $0.30 buy $5 of ${JUP} as "dip"`)
    await w.tool.call(agentA, { action: "off", all: true })
    const rows = w.journal.rows().filter((r) => r.type === "trigger.changed" && r.on === false)
    expect(rows.map((r) => [r.name, r.sells])).toEqual([["dip", undefined], ["stop", [JUP]]])
  })

  test("another agent's trigger is never narrowed at once: a card", async () => {
    const w = await world()
    // Saved to trade as agent-a, by a line that says so: agent-b's narrower line reads the same but for its level.
    await save(w.book, `when ${JUP} < $0.40 buy $5 of ${JUP} as agent-a as "stop"`, "agent-b")
    expect(w.book.entry("stop")!.agent).toBe("agent-a")
    expect(await w.tool.call(agentB, { action: "propose", line: `when ${JUP} < $0.30 buy $5 of ${JUP} as agent-a as "stop"`, replace: true })).toEqual({ card: "op_1" })
    expect(w.book.entry("stop")!.line).toBe(`when ${JUP} < $0.40 buy $5 of ${JUP} as agent-a`)
    // Its own agent narrows it at once.
    expect(await w.tool.call(agentA, { action: "propose", line: `when ${JUP} < $0.30 buy $5 of ${JUP} as agent-a as "stop"`, replace: true })).toMatchObject({ ok: true })
  })

  test("a narrowing keeps the trigger's own mode, whatever the Candle Harness's is; a card takes the mode now", async () => {
    const w = await world()
    w.now.mode = "paper"
    await save(w.book, `when ${JUP} < $0.40 buy $5 of ${JUP} as "stop"`)
    w.now.mode = "live"
    expect(await w.tool.call(agentA, { action: "propose", line: `when ${JUP} < $0.30 buy $5 of ${JUP} as "stop"`, replace: true })).toMatchObject({ ok: true })
    expect(w.book.entry("stop")).toMatchObject({ mode: "paper", line: `when ${JUP} < $0.30 buy $5 of ${JUP}` })
    expect(w.book.view().triggers[0]?.held).toBeUndefined()
    // Wider is a card, in the mode now, and its words say it would go live.
    expect(await w.tool.call(agentA, { action: "propose", line: `when ${JUP} < $0.50 buy $5 of ${JUP} as "stop"`, replace: true })).toEqual({ card: "op_1" })
    expect(w.proposed[0]!.card.spec.mode).toBe("live")
    expect(w.proposed[0]!.card.spec.runs).toEndWith('"stop" is a paper trigger now: this makes it a live one.')
    const read = (await w.tool.call(agentA, { action: "read" })) as unknown as { body: { triggers: { mode: string }[] } }
    expect(read.body.triggers[0]!.mode).toBe("paper")
  })

  test("a P&L trigger changed with no window keeps its own; another window is a card, not a narrowing", async () => {
    const w = await world()
    w.now.window = "midnight"
    await save(w.book, `when pnl < -$20 notify as "loss"`)
    w.now.window = "session"
    expect(await w.tool.call(agentA, { action: "propose", line: `when pnl < -$30 notify as "loss"`, replace: true })).toMatchObject({ ok: true, body: { done: 'Changed "loss" at once, since it only narrows it: its level, from -$20 to -$30.' } })
    expect(w.book.entry("loss")!.expansion).toBe("when pnl today < -$30 notify")
    expect(await w.tool.call(agentA, { action: "propose", line: `when pnl 24h < -$40 notify as "loss"`, replace: true })).toEqual({ card: "op_1" })
  })

  test("Free proposes nothing, in the gate's words; a malformed call is said", async () => {
    const w = await world({ plan: "free" })
    expect(await w.tool.call(agentA, { action: "propose", line: `when ${JUP} < $0.40 sell 50% of ${JUP}` })).toMatchObject({ ok: false, code: "TRIGGERS_NEED_PLAN" })
    expect(await w.tool.call(agentA, { action: "read" })).toMatchObject({ ok: true, body: { gate: "Triggers need a Pro or Max plan. The owner upgrades with candle plan buy." } })
    expect(await w.tool.call(agentA, { action: "save" })).toMatchObject({ ok: false, code: "MCP_VALIDATION" })
    expect(await w.tool.call(agentA, { action: "propose" })).toMatchObject({ ok: false, code: "MCP_VALIDATION" })
    expect(w.proposed).toHaveLength(0)
  })
})

describe("an approved trigger card", () => {
  const params = (w: Awaited<ReturnType<typeof world>>, line: string, replace = false): TriggerCardParams => {
    const c = w.book.check(line, "agent-a")
    return { line: c.line, proposer: "agent-a", name: c.trigger.name, expansion: c.trigger.expansion, replace }
  }

  test("saved as the card showed it, and read back as saved after a restart", async () => {
    const w = await world()
    const p = params(w, `when JUP < $0.40 sell 50% of JUP as "stop"`)
    expect(readTriggerCard(w.book, { params: p as never })).toMatchObject({ state: "failed", error: { code: "NOT_SAVED" } })
    expect(await runTriggerCard(w.book, { params: p as never, cardId: "c1", opId: "o1" })).toEqual({ state: "succeeded", result: { done: true, trigger: "stop", replaced: false, on: true } })
    expect(w.book.entry("stop")).toMatchObject({ line: `when JUP < $0.40 sell 50% of JUP`, expansion: `when ${JUP} < $0.40 sell 50% of ${JUP}` })
    expect(w.journal.rows().at(-1)).toMatchObject({ type: "trigger.saved", cardId: "c1", opId: "o1" })
    expect(readTriggerCard(w.book, { params: p as never })).toMatchObject({ state: "succeeded" })
  })

  test("refused, naming it, when an alias it used changed after the card was made", async () => {
    const w = await world()
    const p = params(w, `when JUP < $0.40 b5 JUP as "dip"`)
    writeFileSync(w.config, '[aliases]\nb5 = "buy $50 of"\n')
    const ran = await runTriggerCard(w.book, { params: p as never, cardId: "c1", opId: "o1" })
    expect(ran).toMatchObject({ state: "refused", error: { code: "LINE_CHANGED" } })
    expect(String((ran.error as { message: string }).message)).toContain(`buy $50 of ${JUP} rather than when ${JUP} < $0.40 buy $5 of ${JUP}`)
    expect(w.book.entries()).toEqual([])
  })

  test("saved in the mode its card was made in", async () => {
    const w = await world()
    w.now.mode = "paper"
    const p = { ...params(w, `when JUP < $0.40 sell 50% of JUP as "stop"`), mode: "paper" as const }
    await runTriggerCard(w.book, { params: p as never, cardId: "c1", opId: "o1" })
    expect(w.book.entry("stop")!.mode).toBe("paper")
    expect(w.journal.rows().at(-1)).toMatchObject({ type: "trigger.saved", mode: "paper" })
  })

  test("a replacing card replaces; a new one whose name was taken since is refused", async () => {
    const w = await world()
    const p = params(w, `when JUP < $0.40 sell 50% of JUP as "stop"`)
    await save(w.book, `when JUP < $0.30 sell 10% of JUP as "stop"`)
    expect(await runTriggerCard(w.book, { params: p as never, cardId: "c1", opId: "o1" })).toMatchObject({ state: "refused", error: { code: "NAME_TAKEN" } })
    expect(await runTriggerCard(w.book, { params: { ...p, replace: true } as never, cardId: "c2", opId: "o2" })).toMatchObject({ state: "succeeded", result: { replaced: true } })
    expect(w.book.entry("stop")!.line).toBe("when JUP < $0.40 sell 50% of JUP")
  })
})
