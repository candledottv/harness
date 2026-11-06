import { expect, test } from "bun:test"
import { PLAN_REFRESH_MS, PlanState, planLine, reaches } from "./plan-state"

function harness(tiers: Record<string, string | undefined>, readAt = 0) {
  let t = readAt
  const statuses = new Map(Object.entries(tiers).map(([a, tier]) => [a, { tier, readAt }]))
  const refreshed: string[] = []
  let changes = 0
  const plans = new PlanState({
    status: {
      get: (a) => statuses.get(a),
      refresh: async (a) => {
        refreshed.push(a)
        statuses.set(a, { tier: tiers[a], readAt: t })
      },
    },
    agents: () => Object.keys(tiers),
    now: () => t,
    onChange: () => changes++,
  })
  return { plans, refreshed, tiers, setNow: (n: number) => (t = n), changes: () => changes }
}

test("the plan comes from each agent's status read; unknown until one names it", () => {
  const { plans } = harness({ "agent-a": "max", "agent-b": undefined })
  expect(plans.planFor("agent-a")).toEqual({ plan: "max", readAt: 0 })
  expect(plans.planFor("agent-b").plan).toBeUndefined()
  expect(plans.planFor("nobody")).toEqual({ plan: undefined, readAt: undefined })
})

test("an unknown plan is offered as Free", () => {
  expect(reaches(undefined, "free")).toBe(true)
  expect(reaches(undefined, "pro")).toBe(false)
  expect(reaches("pro", "pro")).toBe(true)
  expect(reaches("pro", "max")).toBe(false)
  expect(reaches("max", "pro")).toBe(true)
})

test("the refresh re-reads a stale status, and reports a change of plan", async () => {
  const h = harness({ "agent-a": "pro" })
  await h.plans.refresh()
  expect(h.changes()).toBe(1) // the first look
  h.setNow(60_000)
  await h.plans.refresh()
  expect(h.refreshed).toEqual([]) // read at 0, so not yet stale
  expect(h.changes()).toBe(1)
  h.tiers["agent-a"] = "max"
  h.setNow(PLAN_REFRESH_MS + 1)
  await h.plans.refresh()
  expect(h.refreshed).toEqual(["agent-a"])
  expect(h.plans.planFor("agent-a").plan).toBe("max")
  expect(h.changes()).toBe(2)
})

test("the prompt's line states what the next plan adds, once, with no pitch", () => {
  expect(planLine("pro")).toBe(
    "This account is on Pro: the strategy lab (backtests, replays, research reports) and wallet book legs need Max. They aren't among your tools, and there's no other way to them: when asked for one, say which plan it needs, rather than looking for it.",
  )
  expect(planLine("max")).not.toMatch(/upgrade|\$/i)
  expect(planLine(undefined)).toContain("isn't known yet")
})
