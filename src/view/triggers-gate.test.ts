// On Free, a typed trigger line is refused with the plan's words and never reaches the agent; prose that only
// starts like one ("on second thought…") still goes to the agent, and on Pro or Max a trigger line goes to the
// agent, which clarifies it and proposes the trigger on a card.
import { expect, test } from "bun:test"
import { triggersGated } from "./app"
import { readLine } from "./keys"

const MOON = "MoonFake11111111111111111111111111111111111"
const commands = { agents: ["momentum"], knownTokens: new Map([["MOON", MOON]]), activeAgent: "momentum", mode: "live" as const }
const hacc = (...plans: (string | null)[]) => ({ enabled: true, agents: Object.fromEntries(plans.map((plan, i) => [`a${i}`, { plan, key: "ok" as const }])), stream: { state: "closed", mine: { state: "closed" } } })

test("gated only when every plan read is Free", () => {
  expect(triggersGated(undefined)).toBeUndefined()
  expect(triggersGated(hacc(null))).toBeUndefined()
  expect(triggersGated(hacc("free", "pro"))).toBeUndefined()
  expect(triggersGated(hacc("free", null))).toBe("Triggers need a Pro or Max plan. This account is on Free, so nothing was sent: candle plan buy upgrades it.")
})

test("on Free a trigger's line is refused with the plan's words; prose still goes to the agent", () => {
  const free = { commands, triggersGated: triggersGated(hacc("free")) }
  for (const line of ["when MOON < $0.40 sell 50% of MOON", "every day 09:00 buy $5 of MOON", "on call notify"]) {
    expect(readLine(line, free)).toEqual({ kind: "refused", message: free.triggersGated! })
  }
  expect(readLine("on second thought, what's MOON doing?", free)).toEqual({ kind: "agent", text: "on second thought, what's MOON doing?" })
  expect(readLine("sell 50% of MOON", free)?.kind).toBe("trade")
})

test("on Pro or Max a trigger's line goes to the agent, which proposes it: nothing is saved from the line", () => {
  expect(readLine("when MOON < $0.40 sell 50% of MOON", { commands })).toEqual({ kind: "agent", text: "when MOON < $0.40 sell 50% of MOON" })
})
