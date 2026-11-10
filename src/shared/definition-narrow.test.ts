// What narrows a bot at once and what's a new card: each field one way and the other.
import { describe, expect, test } from "bun:test"
import { type BotRunSettings, type Definition, readDefinition } from "./definition"
import { changes, narrowing } from "./definition-narrow"

const BASE = {
  chain: "solana",
  entry: { source: "pattern", pattern: "confluence", filters: { max_mcap_usd: 500_000, max_age_minutes: 60 } },
  exit: { take_profit_pct: 100, stop_loss_pct: 40, max_hold_hours: 24 },
  sizing: { usd_per_trade: 2, max_concurrent: 4 },
}
const RUN: BotRunSettings = { agent: "agent-a", wallet: "embedded", mode: "paper" }

const def = (patch: (d: typeof BASE & Record<string, unknown>) => void = () => {}): Definition => {
  const d = structuredClone(BASE) as typeof BASE & Record<string, unknown>
  patch(d)
  const r = readDefinition(d)
  if (!r.ok) throw new Error(r.message)
  return r.definition
}
const was = { definition: def(), run: RUN }
const to = (d: Definition, run: Partial<BotRunSettings> = {}) => narrowing(was, { definition: d, run: { ...RUN, ...run } }, 100)

describe("narrower, at once", () => {
  test("each figure moved the safe way says what moved", () => {
    expect(
      to(
        def((d) => {
          d.entry.filters.max_mcap_usd = 300_000
          d.exit.stop_loss_pct = 30
          d.exit.max_hold_hours = 12
          d.sizing.usd_per_trade = 1
          d.sizing.max_concurrent = 2
        }),
      ),
    ).toEqual({
      ok: true,
      what: ["a market cap ceiling of $300K, from $500K", "a stop at -30%, from -40%", "a hold of at most 12 hours, from 24 hours", "a stake of $1, from $2", "at most 2 at once, from 4 at once"],
    })
  })

  test("a filter, an exit, a cap or a skip rule added; one chain where it watched both; a tighter slippage bound", () => {
    expect(to(def((d) => void ((d.entry.filters as Record<string, unknown>).min_mcap_usd = 50_000))).ok).toBe(true)
    expect(to(def((d) => void ((d.exit as Record<string, unknown>).trailing = { arm_multiple: 2, drop_pct: 20 })))).toEqual({ ok: true, what: ["a trailing exit, added"] })
    expect(to(def((d) => void ((d.sizing as Record<string, unknown>).max_usd = 2)))).toEqual({ ok: true, what: ["a cap of $2 a trade, added"] })
    expect(to(def((d) => void ((d.sizing as Record<string, unknown>).rules = [{ when: { mcap_at_entry: { gt: 400_000 } }, skip: true }])))).toEqual({ ok: true, what: ["a skip rule, added"] })
    const both = { definition: def((d) => void (d.chain = "any")), run: RUN }
    expect(narrowing(both, { definition: def(), run: RUN }, 100)).toEqual({ ok: true, what: ["only Solana, from both chains"] })
    // A looser bound tightened, as far as the route's own 1%.
    const loose = { definition: def(), run: { ...RUN, maxSlippageBps: 500 } }
    expect(narrowing(loose, { definition: def(), run: { ...RUN, maxSlippageBps: 100 } }, 100)).toEqual({ ok: true, what: ["slippage 1%, from 5%"] })
    expect(narrowing(loose, { definition: def(), run: { ...RUN, maxSlippageBps: 250 } }, 100)).toEqual({ ok: true, what: ["slippage 2.5%, from 5%"] })
  })

  test("nothing changed is no narrowing: an empty list", () => {
    expect(to(def())).toEqual({ ok: true, what: [] })
  })
})

describe("wider, a new card", () => {
  test.each([
    ["a higher ceiling", (d: typeof BASE) => void (d.entry.filters.max_mcap_usd = 900_000), "a market cap ceiling of $900K is over its $500K"],
    ["a filter dropped", (d: typeof BASE) => void delete (d.entry.filters as Record<string, unknown>).max_age_minutes, "it drops a greatest age of"],
    ["a looser stop", (d: typeof BASE) => void (d.exit.stop_loss_pct = 60), "a stop at -60% is over its -40%"],
    ["an exit dropped", (d: typeof BASE) => void delete (d.exit as Record<string, unknown>).take_profit_pct, "it drops a take profit at"],
    ["a bigger stake", (d: typeof BASE) => void (d.sizing.usd_per_trade = 5), "a stake of $5 is over its $2"],
    ["a bigger stake behind base_usd", (d: typeof BASE) => void ((d.sizing as Record<string, unknown>).base_usd = 10), "a stake of $10 is over its $2"],
    ["more at once", (d: typeof BASE) => void (d.sizing.max_concurrent = 6), "at most 6 at once is over its 4 at once"],
    ["another pattern", (d: typeof BASE) => void (d.entry.pattern = "new_ticker"), "another pattern is a new card"],
    ["another chain", (d: typeof BASE) => void (d.chain = "hood"), "another chain is a new card"],
    ["a sizing rule that doubles", (d: typeof BASE) => void ((d.sizing as Record<string, unknown>).rules = [{ when: { mcap_at_entry: { lt: 100_000 } }, mult: 2 }]), "its sizing rules changed"],
  ])("%s", (_label, patch, words) => {
    const n = to(def(patch as (d: typeof BASE & Record<string, unknown>) => void))
    expect(n.ok).toBe(false)
    if (!n.ok) expect(n.wider).toContain(words)
  })

  test("a slippage bound under the route's default binds its sells, which may then not fill: a card, not a narrowing", () => {
    for (const bps of [50, 20, 1, 0]) {
      const n = to(def(), { maxSlippageBps: bps })
      expect(n.ok).toBe(false)
      if (!n.ok) expect(n.wider).toContain("is under the route's 1%, and a bound that tight can make its sells fail")
    }
    const loose = { definition: def(), run: { ...RUN, maxSlippageBps: 500 } }
    expect(narrowing(loose, { definition: def(), run: { ...RUN, maxSlippageBps: 99 } }, 100).ok).toBe(false)
  })

  test.each([
    ["wallet_ids", [12, 40]],
    ["groups", ["smart_money"]],
    ["groups_all", ["smart_money"]],
    ["venues", ["pump"]],
    ["exclude_venues", ["pump"]],
  ] as const)("a list emptied takes its filter away, so it's wider: %s", (key, list) => {
    const pattern = key === "wallet_ids" ? "large_move" : "confluence"
    const filtered: Definition = { ...def(), entry: { source: "pattern", pattern, filters: { max_mcap_usd: 500_000, [key]: list } } } as Definition
    // The reader refuses an empty list; one that reaches here another way is judged the same.
    const emptied = { ...filtered, entry: { ...filtered.entry, filters: { max_mcap_usd: 500_000, [key]: [] } } } as Definition
    const n = narrowing({ definition: filtered, run: RUN }, { definition: emptied, run: RUN }, 100)
    expect(n.ok).toBe(false)
    // And from an empty list to a filled one is a filter added.
    if (key === "wallet_ids" || key === "groups" || key === "venues") expect(narrowing({ definition: emptied, run: RUN }, { definition: filtered, run: RUN }, 100).ok).toBe(true)
  })

  test("an exit moved so near that it sells almost as soon as the bot buys is a card", () => {
    const cases: [(d: typeof BASE) => void, string][] = [
      [(d) => void (d.exit.max_hold_hours = 0.0003), "a hold of at most"],
      [(d) => void (d.exit.max_hold_hours = 0.05), "a hold of at most 3 minutes is under 5 minutes"],
      [(d) => void (d.exit.stop_loss_pct = 0.5), "a stop at -0.5% is under 1%"],
      [(d) => void (d.exit.take_profit_pct = 0.2), "a take profit at +0.2% is under 1%"],
      [(d) => void ((d.exit as Record<string, unknown>).trailing = { arm_multiple: 1, drop_pct: 0.1 }), "a trailing exit on a 0.1% fall is under 1%"],
    ]
    for (const [patch, words] of cases) {
      const n = to(def(patch as (d: typeof BASE & Record<string, unknown>) => void))
      expect(n.ok).toBe(false)
      if (!n.ok) expect(n.wider).toContain(words)
    }
    // At the floors it still takes at once.
    expect(to(def((d) => void (d.exit.max_hold_hours = 0.1))).ok).toBe(true)
    expect(to(def((d) => void (d.exit.stop_loss_pct = 1))).ok).toBe(true)
  })

  test("its run settings: going live, another wallet, a looser bound", () => {
    expect(to(def(), { mode: "live" })).toEqual({ ok: false, wider: "taking a bot live is a new card" })
    expect(to(def(), { wallet: "TeeFake1111111111111111111111111111111111111" }).ok).toBe(false)
    expect(to(def(), { maxSlippageBps: 300 })).toEqual({ ok: false, wider: "a slippage bound of 3% is looser than its 1%" })
  })
})

test("what a change changes, either way, field by field, for its card's face", () => {
  const shape = (d: Definition, run: BotRunSettings = RUN) => ({ definition: d, run })
  expect(changes(shape(def()), shape(def((d) => { d.sizing.usd_per_trade = 3; d.exit.stop_loss_pct = 20 })), 100)).toEqual(["a stop at -20%, from -40%", "a stake of $3, from $2"])
  expect(changes(shape(def()), shape(def((d) => { d.entry.filters = { max_age_minutes: 60, min_mcap_usd: 30_000 } as unknown as typeof d.entry.filters })), 100)).toEqual(["a market cap floor of $30K, added", "a market cap ceiling of $500K, dropped"])
  expect(changes(shape(def()), shape(def(), { ...RUN, mode: "live" }), 100)).toEqual(["live, from paper"])
  expect(changes(shape(def()), shape(def()), 100)).toEqual([])
})
