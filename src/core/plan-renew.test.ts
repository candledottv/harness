// The CLI's plan auto-renew (0.13.9): when it would pay in front of a command at the pane's terminal, by
// its own rules, read from the profile's plan state the way the CLI reads it.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { renewBefore, renewDue, renewWarning } from "./plan-renew"

const DAY = 24 * 60 * 60 * 1000
const END = Date.parse("2026-11-10T00:00:00.000Z")
const due = { autoRenew: true, plan: "max", payer: "PayerFake1", periodEnd: new Date(END).toISOString(), renewCeilingRaw: "200000000" }

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
function configDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "chrn-plan-"))
  dirs.push(dir)
  mkdirSync(join(dir, "spend"))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(body))
  return dir
}

describe("whether the CLI renews", () => {
  test("only with auto-renew on, a complete plan, nothing in flight, in the 3 days before the end, and not tried in 12 hours", () => {
    expect(renewDue(due, END - DAY)).toEqual({ plan: "max", periodEnd: due.periodEnd })
    expect(renewDue(due, END - 4 * DAY)).toBeUndefined()
    expect(renewDue(due, END)).toBeUndefined()
    expect(renewDue({ ...due, autoRenew: false }, END - DAY)).toBeUndefined()
    expect(renewDue({ ...due, renewCeilingRaw: undefined }, END - DAY)).toBeUndefined()
    expect(renewDue({ ...due, pending: { id: "x" } }, END - DAY)).toBeUndefined()
    expect(renewDue({ ...due, lastRenewAttemptAt: new Date(END - DAY - 60_000).toISOString() }, END - DAY)).toBeUndefined()
    expect(renewDue({ ...due, lastRenewAttemptAt: new Date(END - 2 * DAY).toISOString() }, END - DAY)).toBeDefined()
    expect(renewDue("not a state", END - DAY)).toBeUndefined()
  })

  test("in front of a command at a terminal, for the profile the Candle Harness acts as; never with --json or for the words the CLI skips", () => {
    const dir = configDir({ "config.json": { profiles: { mine: {}, other: {} }, activeProfile: "other" }, "spend/mine.plan.json": due })
    const env = { CANDLE_CONFIG_DIR: dir }
    expect(renewBefore(["tee", "rename", "a", "b"], env, "mine", END - DAY)).toEqual({ plan: "max", periodEnd: due.periodEnd })
    // The CLI's active profile has no plan state here.
    expect(renewBefore(["tee", "rename", "a", "b"], env, undefined, END - DAY)).toBeUndefined()
    expect(renewBefore(["vault", "list", "--json"], env, "mine", END - DAY)).toBeUndefined()
    for (const word of ["plan", "plans", "spend", "auth", "profile", "doctor"]) expect(renewBefore([word, "x"], env, "mine", END - DAY)).toBeUndefined()
    // With one profile and none recorded, the CLI acts as it; with none at all, as "default".
    expect(renewBefore(["keys", "limit", "x"], { CANDLE_CONFIG_DIR: configDir({ "config.json": { profiles: { solo: {} } }, "spend/solo.plan.json": due }) }, undefined, END - DAY)).toBeDefined()
    expect(renewBefore(["keys", "limit", "x"], { CANDLE_CONFIG_DIR: configDir({ "spend/default.plan.json": due }) }, undefined, END - DAY)).toBeDefined()
    expect(renewBefore(["keys", "limit", "x"], { CANDLE_CONFIG_DIR: configDir({}) }, undefined, END - DAY)).toBeUndefined()
  })

  test("the card's line names the plan, the day it ends and the passphrase", () => {
    expect(renewWarning({ plan: "max", periodEnd: due.periodEnd })).toBe(
      "Your Candle Max plan renews first: auto-renew is on and it ends 2026-11-10, so the CLI pays for the next 30 days before this runs, and asks for your vault passphrase to do it.",
    )
  })
})
