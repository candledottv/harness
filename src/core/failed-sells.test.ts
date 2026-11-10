// The failed-sell hold counts sells still in flight: one sell in flight per key and token, so sells
// sent together can never fail past Candle's streak of three.
import { describe, expect, test } from "bun:test"
import { FailedSells } from "./failed-sells"
import type { JournalRow } from "./journal"

const MOON = "MoonFake11111111111111111111111111111111111"
const row = (fields: Record<string, unknown>): JournalRow => ({ seq: 0, at: "", account: "a", mode: "live", ...fields }) as JournalRow
const card = (opId: string, role = "agent") => row({ type: "card.created", opId, cardId: `card-${opId}`, agent: "momentum", side: "sell", mint: MOON, role })
const sent = (opId: string) => row({ type: "operation.submitting", opId })
const outcome = (opId: string, type: string, code?: string) => row({ type, opId, ...(code ? { error: { code } } : {}) })

describe("sells in flight in the failed-sells hold", () => {
  test("a sell sent and not settled holds the core's next sell of the token on the key; its outcome releases it", () => {
    const f = new FailedSells()
    f.note(card("a"))
    // Waiting for the person: nothing sent, nothing held.
    expect(f.held("momentum", MOON)).toBe(false)
    f.note(sent("a"))
    expect(f.inFlight("momentum", MOON)).toBe(1)
    expect(f.held("momentum", MOON)).toBe(true)
    expect(f.words("momentum", "MOON", MOON)).toContain("still under way")
    // Another key, or another token, isn't held.
    expect(f.held("swing", MOON)).toBe(false)
    // Still unknown after the send: in flight until it's read back.
    f.note(outcome("a", "operation.unknown"))
    expect(f.held("momentum", MOON)).toBe(true)
    f.note(outcome("a", "operation.succeeded"))
    expect(f.held("momentum", MOON)).toBe(false)
  })

  test("a sell sent again under its own id doesn't hold itself; another sell of the token in flight still holds it", () => {
    const f = new FailedSells()
    f.note(card("a"))
    f.note(sent("a"))
    f.note(outcome("a", "operation.unknown"))
    expect(f.held("momentum", MOON, "a")).toBe(false)
    f.note(card("b"))
    f.note(sent("b"))
    expect(f.held("momentum", MOON, "a")).toBe(true)
    expect(f.inFlight("momentum", MOON, "a")).toBe(1)
  })

  test("one failed sell and one in flight: one more could be the third, so the core's waits and the person's is warned", () => {
    const f = new FailedSells([card("a"), sent("a"), outcome("a", "operation.failed")])
    expect(f.held("momentum", MOON)).toBe(false)
    expect(f.atRisk("momentum", MOON)).toBe(false)
    f.note(card("b"))
    f.note(sent("b"))
    expect(f.atRisk("momentum", MOON)).toBe(true)
    expect(f.held("momentum", MOON)).toBe(true)
    // The person's retry doesn't send a second one alongside it.
    expect(f.release("momentum", MOON)).toBe(false)
    expect(f.held("momentum", MOON)).toBe(true)
    f.note(outcome("b", "operation.failed"))
    // Two failed now: the count's hold, which the person's retry lifts once.
    expect(f.held("momentum", MOON)).toBe(true)
    expect(f.release("momentum", MOON)).toBe(true)
    expect(f.held("momentum", MOON)).toBe(false)
  })

  test("the core's own sell is in flight from its card, so two exits can't both pass before either is sent; a card ended unsent ends it", () => {
    const f = new FailedSells()
    f.note(card("x", "core"))
    expect(f.held("momentum", MOON)).toBe(true)
    f.note(row({ type: "card.withdrawn", cardId: "card-x" }))
    expect(f.held("momentum", MOON)).toBe(false)
    // A refusal the core made itself counts nothing, but still ends the flight.
    f.note(card("y", "core"))
    f.note(sent("y"))
    f.note(outcome("y", "operation.refused", "PAUSED"))
    expect(f.count("momentum", MOON)).toBe(0)
    expect(f.held("momentum", MOON)).toBe(false)
  })
})
