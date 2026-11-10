// A code bot's held exits: read as a definition's exit shape, only the exits the core runs; a buy's exits found on the
// position it opened, live or paper; a bot's change or clear after it, the newest winning; the person's removal.
import { describe, expect, test } from "bun:test"
import { readHeldExit } from "../shared/definition"
import { HeldExits } from "./held-exits"
import type { JournalRow } from "./journal"

let seq = 0
const row = (r: Record<string, unknown>): JournalRow => ({ seq: ++seq, at: "2026-11-08T12:00:00.000Z", mode: "live", ...r }) as JournalRow
const MOON = "MoonFake11111111111111111111111111111111111"

describe("readHeldExit", () => {
  test("the four exits the core runs, read by the definition's own rules", () => {
    expect(readHeldExit({ take_profit_pct: 50, stop_loss_pct: 20, max_hold_hours: 2, trailing: { arm_multiple: 1.5, drop_pct: 10 } })).toEqual({ ok: true, exit: { take_profit_pct: 50, stop_loss_pct: 20, max_hold_hours: 2, trailing: { arm_multiple: 1.5, drop_pct: 10 } } })
    expect(readHeldExit({ stop_loss_pct: 25 })).toEqual({ ok: true, exit: { stop_loss_pct: 25 } })
  })

  test("selling on a signal and a ladder are its own code's; nothing, a bad number or an unknown field is refused in the definition's words", () => {
    expect(readHeldExit({ stop_loss_pct: 20, exit_on_signal: true })).toEqual({ ok: false, message: expect.stringContaining("exit_on_signal isn't held by the core") })
    expect(readHeldExit({ ladder: { sell_aggregate: 1 } })).toEqual({ ok: false, message: expect.stringContaining("ladder isn't held by the core") })
    expect(readHeldExit({})).toMatchObject({ ok: false })
    expect(readHeldExit({ exit_on_signal: false })).toEqual({ ok: false, message: expect.stringContaining("at least one of take_profit_pct, stop_loss_pct, max_hold_hours or trailing") })
    expect(readHeldExit({ stop_loss_pct: -5 })).toMatchObject({ ok: false, message: expect.stringContaining("exit.stop_loss_pct") })
    expect(readHeldExit({ stop_loss_pct: 20, take_profit: 50 })).toMatchObject({ ok: false })
    expect(readHeldExit({ trailing: { arm_multiple: 0.5, drop_pct: 10 } })).toMatchObject({ ok: false, message: expect.stringContaining("arm_multiple") })
    expect(readHeldExit("stop at 20%")).toMatchObject({ ok: false })
  })
})

describe("HeldExits", () => {
  const request = (name: string, id: string, exits?: unknown) => row({ type: "bot.request", kind: "code", name, request: id, side: "buy", mint: MOON, ...(exits !== undefined ? { exits } : {}) })
  const created = (name: string, id: string, opId: string) => row({ type: "card.created", opId, bot: name, botAct: "entry", botKind: "code", botRequest: id })

  test("a buy's exits hold on the position its fill opened, live by its operation and paper by its row", () => {
    const h = new HeldExits()
    h.note(request("scalper", "req_live_0001", { stop_loss_pct: 30 }))
    h.note(created("scalper", "req_live_0001", "op_1"))
    h.note(request("scalper", "req_paper_001", { max_hold_hours: 1 }))
    const paper = row({ type: "paper.call", bot: "scalper", botAct: "entry", botKind: "code", botRequest: "req_paper_001" })
    h.note(paper)
    expect(h.of("op_1")).toEqual({ exit: { stop_loss_pct: 30 }, by: "buy", at: expect.any(String) })
    expect(h.of(`paper:${paper.seq}`)?.exit).toEqual({ max_hold_hours: 1 })
  })

  test("a buy with none, another bot's request id, a rules bot's entry: nothing is held", () => {
    const h = new HeldExits()
    h.note(request("scalper", "req_none_0001"))
    h.note(created("scalper", "req_none_0001", "op_1"))
    h.note(request("scalper", "req_same_0001", { stop_loss_pct: 30 }))
    h.note(created("other", "req_same_0001", "op_2"))
    h.note(row({ type: "card.created", opId: "op_3", bot: "conf", botAct: "entry", botSignal: 4 }))
    expect(h.of("op_1")).toBeUndefined()
    expect(h.of("op_2")).toBeUndefined()
    expect(h.of("op_3")).toBeUndefined()
  })

  test("the bot's change after its buy wins, its clear clears, and the person's removal is the person's", () => {
    const h = new HeldExits()
    h.note(request("scalper", "req_live_0001", { stop_loss_pct: 30 }))
    h.note(created("scalper", "req_live_0001", "op_1"))
    h.note(row({ type: "bot.exits_set", name: "scalper", position: "op_1", exits: { stop_loss_pct: 10, take_profit_pct: 80 }, by: "bot" }))
    expect(h.of("op_1")).toMatchObject({ exit: { stop_loss_pct: 10, take_profit_pct: 80 }, by: "bot" })
    h.note(row({ type: "bot.exits_set", name: "scalper", position: "op_1", exits: null, by: "person" }))
    expect(h.of("op_1")).toBeUndefined()
    // Set afresh on a position its buy gave none.
    h.note(row({ type: "bot.exits_set", name: "scalper", position: "op_9", exits: { max_hold_hours: 3 }, by: "bot" }))
    expect(h.of("op_9")).toMatchObject({ exit: { max_hold_hours: 3 }, by: "bot" })
  })
})
