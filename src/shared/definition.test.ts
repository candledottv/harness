// A bot's definition, read by Hacc's own rule: every recorded probe answered as Hacc answered it, every
// recorded replay's and saved strategy's definition read, put in words and hashed the same however it's written;
// what runs live and what's refused with why; and a tape trigger promoted to a definition's entry.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { type BotRunSettings, botHash, type Definition, entryFromTape, liveMarks, readDefinition, refusedLive } from "./definition"
import { BACKTEST_DIFFERS, definitionWords, exitWords, rulesWords } from "./definition-words"
import { parseTriggerShape } from "./trigger-grammar"

const fixtures = join(import.meta.dir, "../../test/fixtures/hacc-recorded")
const bots = join(fixtures, "bots")
type Row = Record<string, unknown>
const json = (path: string): Row => JSON.parse(readFileSync(path, "utf8"))
/** The definition a recorded replay sent. */
const sent = (name: string): unknown => (json(join(bots, `bots-${name}-start.json`)).body as Row).definition

/** Every definition Hacc was sent or answered with, by the file it's in. */
function recordedDefinitions(): { file: string; definition: Row }[] {
  const out: { file: string; definition: Row }[] = []
  const walk = (file: string, v: unknown) => {
    if (Array.isArray(v)) v.forEach((x) => walk(file, x))
    else if (v && typeof v === "object") {
      const o = v as Row
      if (o.definition && typeof o.definition === "object" && !Array.isArray(o.definition)) out.push({ file, definition: o.definition as Row })
      for (const x of Object.values(o)) walk(file, x)
    }
  }
  for (const dir of [fixtures, bots]) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("bots-schema-"))) walk(f, json(join(dir, f)))
  }
  return out
}

const read = (v: unknown): Definition => {
  const r = readDefinition(v)
  if (!r.ok) throw new Error(r.message)
  return r.definition
}
const why = (v: unknown): string => {
  const r = readDefinition(v)
  if (r.ok) throw new Error(`read: ${JSON.stringify(r.definition)}`)
  return r.message
}

const base = (): Row => ({
  chain: "solana",
  entry: { source: "pattern", pattern: "confluence", filters: {} },
  exit: { take_profit_pct: 100 },
  sizing: { usd_per_trade: 5, max_concurrent: 2 },
})
const withEntry = (entry: Row): Row => ({ ...base(), entry })
const withFilters = (filters: Row, pattern = "confluence"): Row => withEntry({ source: "pattern", pattern, filters })
const withExit = (exit: Row): Row => ({ ...base(), exit })
const withSizing = (sizing: Row): Row => ({ ...base(), sizing: { usd_per_trade: 5, max_concurrent: 2, ...sizing } })
const refusals = (d: Row) => refusedLive(read(d)).map((m) => m.path)

describe("the reader agrees with Hacc", () => {
  const probes = readdirSync(bots).filter((f) => f.startsWith("bots-schema-"))

  test("on every recorded probe: what Hacc took it takes, and what Hacc refused it refuses in Hacc's words", () => {
    expect(probes.length).toBe(77)
    for (const f of probes) {
      const rec = json(join(bots, f)) as { body: { definition: unknown }; answer: { code?: string; error?: string } }
      const r = readDefinition(rec.body.definition)
      if (rec.answer.code === "lab_window") expect({ f, ok: r.ok }).toEqual({ f, ok: true })
      else expect({ f, message: r.ok ? "(read)" : r.message }).toEqual({ f, message: String(rec.answer.error) })
    }
  })

  test("reads every definition a replay sent or Hacc saved, and keeps nothing unknown", () => {
    const all = recordedDefinitions()
    const rejected = all.filter(({ definition }) => "extra" in definition)
    // The two Hacc refused, each with these words.
    expect(rejected.map((d) => d.file).sort()).toEqual(["change-strategy-save-bad.json", "replay-bad-definition.json"])
    for (const { file, definition } of all.filter((d) => !rejected.includes(d))) {
      const r = readDefinition(definition)
      expect({ file, ok: r.ok }).toEqual({ file, ok: true })
      if (r.ok) expect(r.definition).toEqual(definition as unknown as Definition)
    }
    for (const { definition } of rejected) expect(why(definition)).toBe("Unrecognized key(s) in object: 'extra'")
  })

  test("reads a copy: changing what it read changes nothing it gave back", () => {
    const d = withFilters({ groups: ["serial"] }, "new_ticker")
    const got = read(d)
    ;((d.entry as Row).filters as Row).groups = ["other"]
    expect(got.entry).toEqual({ source: "pattern", pattern: "new_ticker", filters: { groups: ["serial"] } })
  })

  test("names the first problem by its path, as Hacc does", () => {
    expect(why("x")).toBe("Expected object, received string")
    expect(why({ ...base(), chain: undefined })).toBe("chain: Required")
    expect(why({ ...base(), entry: [] })).toBe("entry: Expected object, received array")
    expect(why({ ...base(), sizing: undefined })).toBe("sizing: Required")
    expect(why({ ...base(), exit: undefined })).toBe("exit: Required")
    expect(why(withFilters({ hours_et: [9, 17, 20] }))).toBe("entry.filters.hours_et: Array must contain at most 2 element(s)")
    expect(why(withFilters({ hours_et: [-1, 4] }))).toBe("entry.filters.hours_et.0: Number must be greater than or equal to 0")
    expect(why(withFilters({ wallet_ids: Array.from({ length: 51 }, (_, i) => i + 1) }, "new_ticker"))).toBe("entry.filters.wallet_ids: Array must contain at most 50 element(s)")
    expect(why(withSizing({ max_concurrent: 1.5 }))).toBe("sizing.max_concurrent: Expected integer, received float")
    expect(why(withSizing({ rules: [{ when: { mcap_at_entry: { lt: "1" } }, mult: 2 }] }))).toBe("sizing.rules.0.when.mcap_at_entry.lt: Expected number, received string")
  })

  test("keeps a floor of its own where Hacc's isn't known, so nothing meaningless runs", () => {
    expect(why(withExit({ stop_loss_pct: 0 }))).toBe("exit.stop_loss_pct: Number must be greater than 0")
    expect(why(withExit({ max_hold_hours: 0 }))).toBe("exit.max_hold_hours: Number must be greater than 0")
    expect(why(withExit({ trailing: { arm_multiple: 1.5, drop_pct: 0 } }))).toBe("exit.trailing.drop_pct: Number must be greater than 0")
    expect(why(withExit({ trailing: { arm_multiple: 1.5, drop_pct: 150 } }))).toBe("exit.trailing.drop_pct: Number must be less than or equal to 100")
    expect(why(withExit({ trailing: { arm_multiple: 1.5, drop_pct: 20, extra: 1 } }))).toBe("exit.trailing: Unrecognized key(s) in object: 'extra'")
    expect(why(withFilters({ min_usd: -5 }, "large_move"))).toBe("entry.filters.min_usd: Number must be greater than or equal to 0")
    expect(why(withFilters({ groups: ["a"], min_group_wallets: 0 }))).toBe("entry.filters.min_group_wallets: Number must be greater than or equal to 1")
    expect(why(withSizing({ rules: [{ when: {}, mult: 0 }] }))).toBe("sizing.rules.0.mult: Number must be greater than 0")
  })

  test("exit_on_signal: false is no exit, as Hacc counts it", () => {
    expect(why(withExit({ exit_on_signal: false }))).toBe("exit: exit must include at least one of take_profit_pct, stop_loss_pct, max_hold_hours, exit_on_signal: true, ladder, or trailing")
  })

  test("reads an entry a bot can't run as far as Hacc's required fields, and keeps the rest for Hacc", () => {
    const signal = read(withEntry({ source: "trade_signal", min_confidence: 0.7, window_minutes: 30 }))
    expect(signal.entry).toEqual({ source: "trade_signal", min_confidence: 0.7, window_minutes: 30 })
    expect(why(withEntry({ source: "trade_signal", min_confidence: "high" }))).toBe("entry.min_confidence: Expected number, received string")
    expect(read({ ...withEntry({ source: "manual" }), exit: undefined }).exit).toBeUndefined()
    expect(read(withExit({ ladder: { sell_aggregate: true, steps: [] } })).exit?.ladder).toEqual({ sell_aggregate: true, steps: [] })
  })
})

describe("what runs live", () => {
  test("a recorded strategy runs whole: a pattern, its bands, the four exits and its sizing", () => {
    const d = read(sent("hour-confluence"))
    expect(liveMarks(d).every((m) => m.runs)).toBe(true)
    expect(liveMarks(d).map((m) => m.path)).toEqual(["chain", "entry.pattern", "entry.filters.max_mcap_usd", "entry.filters.max_age_minutes", "exit.take_profit_pct", "exit.stop_loss_pct", "exit.max_hold_hours", "sizing.usd_per_trade", "sizing.max_concurrent"])
    expect(refusedLive(read(withExit({ trailing: { arm_multiple: 1.3, drop_pct: 15 } })))).toEqual([])
  })

  test("every filter the tape's row or its filtered read carries runs, on the patterns that carry it", () => {
    expect(refusals(withFilters({ min_mcap_usd: 1e4, max_mcap_usd: 5e5, min_age_minutes: 1, max_age_minutes: 60, venues: ["pump"], hours_et: [9, 17] }))).toEqual([])
    expect(refusals(withFilters({ groups: ["serial"], groups_all: ["kol"], wallet_ids: [12], min_usd: 100 }, "new_ticker"))).toEqual([])
    expect(refusals(withFilters({ min_usd: 15000, direction: "in" }, "large_move"))).toEqual([])
    expect(refusals(withFilters({ direction: "out", exclude_venues: ["pump"] }, "intra_book"))).toEqual([])
  })

  test("refuses each filter it can't check live, with why", () => {
    const one = (d: Row) => {
      const r = refusedLive(read(d))
      expect(r.length).toBe(1)
      return `${r[0]!.path}: ${r[0]!.why}`
    }
    expect(one(withFilters({ min_score_1h: 1 }))).toBe("entry.filters.min_score_1h: Hacc's tape carries no score, so min_score_1h can't be checked live, so this can be backtested, not run.")
    expect(one(withFilters({ groups: ["serial"] }))).toBe("entry.filters.groups: A confluence signal's wallets carry no groups on Hacc's tape, so groups can't be checked live, so this can be backtested, not run.")
    expect(one(withFilters({ groups_all: ["serial"] }))).toContain("groups_all can't be checked live")
    expect(one(withFilters({ min_usd: 100 }, "intra_book"))).toBe("entry.filters.min_usd: A intra_book signal carries no dollar size on Hacc's tape, so min_usd can't be checked live, so this can be backtested, not run.")
    expect(one(withFilters({ min_usd: 100 }, "dormancy"))).toContain("carries no dollar size")
    expect(one(withFilters({ direction: "in" }, "new_ticker"))).toContain("doesn't say which way the tokens moved")
    expect(refusals(withFilters({ groups: ["serial"], min_group_wallets: 2 }, "new_ticker"))).toEqual(["entry.filters.min_group_wallets"])
    expect(one(withFilters({ min_mcap_usd: 5e5, max_mcap_usd: 1e5 }))).toBe("entry.filters.max_mcap_usd: The market cap filters leave nothing between them, so it would never enter.")
    expect(one(withFilters({ min_age_minutes: 60, max_age_minutes: 60 }))).toContain("The age filters leave nothing between them")
  })

  test("refuses the entries a bot can't watch, and says what can do it instead", () => {
    const source = (entry: Row) => refusedLive(read({ ...withEntry(entry), ...(entry.source === "manual" ? { exit: undefined } : {}) }))[0]?.why
    expect(source({ source: "trade_signal", min_confidence: 0.7 })).toBe("Hacc has no live read of its trade signals yet, so this can be backtested, not run.")
    expect(source({ source: "conviction", score_window_minutes: 60 })).toBe("Hacc has no live read of its conviction scores yet, so this can be backtested, not run.")
    expect(source({ source: "levels", chain: "solana" })).toContain("A trigger on a price level does this live.")
    expect(source({ source: "schedule", usd_per_asset: 5 })).toContain("A trigger on a schedule does this live.")
    expect(source({ source: "launch_fingerprint", chain: "solana" })).toContain("backtested, not run")
    expect(source({ source: "manual" })).toContain("backtested, not run")
  })

  test("refuses exit on signal and a ladder, and sizing rules on anything but the market cap at entry", () => {
    expect(refusedLive(read(withExit({ take_profit_pct: 50, exit_on_signal: true })))).toEqual([{ path: "exit.exit_on_signal", runs: false, why: "Hacc's replay hasn't shown what this exits on, so this can be backtested, not run." }])
    expect(refusals(withExit({ ladder: { sell_aggregate: true } }))).toEqual(["exit.ladder"])
    const sizing = read(sent("sizing"))
    expect(refusedLive(sizing)).toEqual([{ path: "sizing.rules.2", runs: false, why: "There's no live read of tracked_buyers_at_trigger, so a rule on it can be backtested, not run." }])
    expect(refusals(withSizing({ rules: [{ when: { mcap_at_entry: { lt: 1e5 }, score_15m: { gt: 1 } }, mult: 2 }] }))).toEqual(["sizing.rules.0"])
    expect(refusals(withSizing({ rules: [{ when: { mcap_at_entry: { lt: 3e5 } }, mult: 2 }, { when: { mcap_at_entry: { gte: 2e6 } }, skip: true }] }))).toEqual([])
  })
})

describe("in words", () => {
  test("the bot in three sentences, as its card shows it", () => {
    const d = read({
      chain: "solana",
      entry: { source: "pattern", pattern: "confluence", filters: { max_mcap_usd: 500_000, max_age_minutes: 60 } },
      exit: { take_profit_pct: 100, stop_loss_pct: 40, max_hold_hours: 24 },
      sizing: { usd_per_trade: 2, max_concurrent: 4 },
    })
    expect(definitionWords(d)).toBe("Buys $2 when several tracked wallets buy the same token, under $500K market cap and under 1 hour old. Sells at +100%, at -40%, or after 24 hours. At most 4 at once.")
  })

  test("every recorded definition has words, with no field left as code", () => {
    for (const { file, definition } of recordedDefinitions().filter(({ definition }) => !("extra" in definition))) {
      const words = definitionWords(read(definition))
      expect({ file, words }).toEqual({ file, words: expect.stringMatching(/^Buys \$\d+ when .+\. Sells .+\. (At most \d+ at once|One at a time)\.$/) })
      expect(words).not.toMatch(/_|undefined|NaN|\{/)
    }
  })

  test("each filter, exit and sizing rule as Hacc's replay reads it", () => {
    const filters = definitionWords(read({ ...withFilters({ min_mcap_usd: 5e4, max_mcap_usd: 2.5e6, min_age_minutes: 10, groups: ["serial", "kol"], venues: ["pump"], hours_et: [9, 17], wallet_ids: [7] }, "new_ticker"), chain: "hood" }))
    expect(filters).toBe("Buys $5 when a tracked wallet buys a token for the first time, between $50K and $2.5M market cap, over 10 minutes old, from a wallet in serial or kol, from Hacc's wallet #7, launched on pump, from hour 9 to hour 17, US Eastern time and on Hood. Sells at +100%. At most 2 at once.")
    expect(definitionWords(read(withFilters({ min_usd: 15000, direction: "in" }, "large_move")))).toContain("a large buy, sell or transfer of a token, a trade of at least $15K and tokens moving in.")
    expect(definitionWords(read({ ...base(), chain: "any" }))).toContain("the same token, on Solana or Hood.")
    expect(exitWords({ trailing: { arm_multiple: 1.3, drop_pct: 15 }, max_hold_hours: 0.5 })).toBe("Sells on a 15% fall from its peak once it's reached 1.3× what it paid or after 30 minutes.")
    expect(exitWords({ stop_loss_pct: 101, take_profit_pct: 50 })).toBe("Sells at +50%. A stop at -101% never fires.")
    expect(exitWords({ stop_loss_pct: 100 })).toBe("A stop at -100% never fires.")
    expect(exitWords({ max_hold_hours: 1.5 })).toBe("Sells after 1.5 hours.")
    expect(exitWords({ max_hold_hours: 1 })).toBe("Sells after 1 hour.")
    const sizing = read(sent("sizing"))
    expect(definitionWords(sizing).startsWith("Buys $5 when")).toBe(true)
    expect(rulesWords(sizing.sizing)).toBe("2× the stake when its market cap at entry is under $300K, skips it when its market cap at entry is at least $2M, adds 5 to the stake's multiple when the count of tracked buyers at the signal is at least 3 and never more than $20 a trade.")
    expect(concurrent(1)).toBe("One at a time.")
  })

  test("says what an entry a bot can't run waits for", () => {
    expect(definitionWords(read(withEntry({ source: "trade_signal", min_confidence: 0.7 })))).toBe("Buys $5 when Hacc gives a trade signal. Sells at +100%. At most 2 at once.")
    expect(definitionWords(read({ ...withEntry({ source: "manual" }), exit: undefined }))).toBe("Buys $5 when you buy by hand on Hacc's manual desk. Takes no exit: Hacc's manual desk. At most 2 at once.")
  })

  test("says how Hacc's backtest differs from a live run", () => {
    expect(BACKTEST_DIFFERS).toContain("first price after the signal")
    expect(BACKTEST_DIFFERS).toContain("5% under its level")
  })
})

const concurrent = (n: number) => definitionWords(read(withSizing({ max_concurrent: n }))).split(". ").at(-1)

describe("the hash", () => {
  const run: BotRunSettings = { agent: "agent-a", wallet: "embedded", mode: "paper" }
  const d = () => read(sent("hour-confluence"))

  test("is the same however the definition is written", () => {
    const h = botHash(d(), run)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    const reordered = JSON.parse(JSON.stringify({ sizing: d().sizing, exit: { max_hold_hours: 24, stop_loss_pct: 40, take_profit_pct: 100 }, entry: d().entry, chain: "solana" }))
    expect(botHash(read(reordered), run)).toBe(h)
    expect(botHash(read(JSON.parse(JSON.stringify(d()).replace('"take_profit_pct":100', '"take_profit_pct":100.0'))), run)).toBe(h)
    expect(botHash(d(), { ...run, maxSlippageBps: undefined })).toBe(h)
  })

  test("changes with anything the bot does, and not with what it's called", () => {
    const h = botHash(d(), run)
    const changed = (fn: (x: Definition) => void) => {
      const x = d()
      fn(x)
      return botHash(x, run)
    }
    expect(changed((x) => (x.sizing.usd_per_trade = 11))).not.toBe(h)
    expect(changed((x) => (x.exit!.stop_loss_pct = 41))).not.toBe(h)
    expect(changed((x) => (x.chain = "any"))).not.toBe(h)
    for (const other of [{ ...run, agent: "agent-b" }, { ...run, wallet: "TeeFake1111111111111111111111111111111111111" }, { ...run, mode: "live" as const }, { ...run, maxSlippageBps: 500 }]) {
      expect(botHash(d(), other)).not.toBe(h)
    }
    expect(Object.keys(run)).not.toContain("name")
  })
})

describe("a tape trigger, promoted", () => {
  const when = (line: string) => {
    const r = parseTriggerShape(line)
    if (!r.ok) throw new Error(r.message)
    return r.value.when
  }

  test("becomes a definition's chain and entry, its filters as Hacc names them", () => {
    const r = entryFromTape(when("when confluence mcap < 500k age < 60m chain solana buy $2 of it"))
    expect(r).toEqual({ ok: true, chain: "solana", entry: { source: "pattern", pattern: "confluence", filters: { max_mcap_usd: 500_000, max_age_minutes: 60 } } })
    if (!r.ok) return
    const d = read({ chain: r.chain, entry: r.entry, exit: { stop_loss_pct: 30 }, sizing: { usd_per_trade: 2, max_concurrent: 4 } })
    expect(refusedLive(d)).toEqual([])
    expect(definitionWords(d)).toBe("Buys $2 when several tracked wallets buy the same token, under $500K market cap and under 1 hour old. Sells at -30%. At most 4 at once.")
  })

  test("watches both chains where the trigger named none, and keeps its group", () => {
    const r = entryFromTape(when("when new_ticker mcap > 50k group serial notify"))
    expect(r).toEqual({ ok: true, chain: "any", entry: { source: "pattern", pattern: "new_ticker", filters: { min_mcap_usd: 50_000, groups: ["serial"] } } })
    const confluence = entryFromTape(when("when confluence group serial notify"))
    if (!confluence.ok) throw new Error(confluence.message)
    expect(refusals({ chain: confluence.chain, entry: confluence.entry, exit: { take_profit_pct: 50 }, sizing: { usd_per_trade: 2, max_concurrent: 1 } })).toEqual(["entry.filters.groups"])
  })

  test("refuses a pattern Hacc's lab doesn't enter on, and anything not on the tape", () => {
    expect(entryFromTape(when("when distribution notify"))).toEqual({ ok: false, message: "Hacc's lab doesn't enter on distribution signals, so this trigger can't become a bot. It can stay a trigger." })
    expect(entryFromTape(when("when JUP < $0.40 notify"))).toEqual({ ok: false, message: "Only a trigger on Hacc's tape can become a bot: a bot enters on the tape's signals." })
  })
})
