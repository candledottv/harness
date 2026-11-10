// A trigger's line, read by one rule: each condition, schedule, event and action, its words, its refusals with
// why, and an expansion that reads back the same with no names and no aliases.
import { describe, expect, test } from "bun:test"
import { parseCommand } from "./commands"
import {
  DEFAULT_COOLDOWN_MS,
  fullLine,
  IT_MINT,
  parseTriggerShape,
  renderCommand,
  resolveTrigger,
  startsLikeTrigger,
  type TriggerContext,
} from "./trigger-grammar"

const JUP = "JupFake111111111111111111111111111111111111"
const MOON = "MoonFake11111111111111111111111111111111111"
const ctx = (over: Partial<TriggerContext> = {}): TriggerContext => ({
  agents: ["agent-a", "agent-b"],
  knownTokens: new Map([
    ["JUP", JUP],
    ["MOON", MOON],
  ]),
  proposer: "agent-a",
  mode: "live",
  aliases: new Map([["b5", "buy $5 of"]]),
  ...over,
})
const read = (line: string, over: Partial<TriggerContext> = {}) => resolveTrigger(line, ctx(over))
const ok = (line: string, over: Partial<TriggerContext> = {}) => {
  const r = read(line, over)
  if (!r.ok) throw new Error(`${line}: ${r.message}`)
  return r.value
}
const why = (line: string, over: Partial<TriggerContext> = {}) => {
  const r = read(line, over)
  if (r.ok) throw new Error(`${line} read as ${r.value.expansion}`)
  return r.message
}

describe("the three leads", () => {
  test("a level, a schedule and the tape", () => {
    const stop = ok("when JUP < $0.40 sell 50% of JUP")
    expect(stop).toMatchObject({ name: "JUP < $0.40", agent: "agent-a", class: "level", again: false, expansion: `when ${JUP} < $0.40 sell 50% of ${JUP}` })
    expect(stop.when).toEqual({ kind: "price", token: JUP, op: "<", usd: 0.4, figure: "$0.40" })
    expect(stop.words).toBe("When JUP's price falls below $0.40, sell 50% of JUP. Fires once, then switches off.")
    const daily = ok("every day 09:00 buy $5 of JUP")
    expect(daily).toMatchObject({ name: "every day 09:00", class: "schedule", expansion: `every day 09:00 buy $5 of ${JUP}` })
    expect(daily.cooldownMs).toBeUndefined()
    expect(daily.words).toBe("Every day at 09:00, this machine's time, buy $5 of JUP. Runs each time.")
    const wake = ok("when confluence mcap < 500k wake agent-a")
    expect(wake).toMatchObject({ class: "tape", cooldownMs: DEFAULT_COOLDOWN_MS, action: { kind: "wake", agent: "agent-a" } })
    expect(wake.when).toEqual({ kind: "tape", pattern: "confluence", filters: { maxMcapUsd: 500_000 } })
    expect(wake.words).toBe("When Hacc's tape shows a confluence signal (market cap under $500K), wake agent-a. Fires each time, once per token every 30 minutes.")
  })

  test("every condition", () => {
    expect(ok("when JUP > $1 notify").when).toMatchObject({ kind: "price", op: ">", usd: 1 })
    expect(ok("when JUP mcap < 2.5m notify").when).toMatchObject({ kind: "mcap", op: "<", usd: 2_500_000 })
    expect(ok("when JUP mcap > $1b notify").when).toMatchObject({ kind: "mcap", op: ">", usd: 1e9 })
    expect(ok("when JUP down 20% sell 100% of JUP").when).toEqual({ kind: "entry", token: JUP, dir: "down", percent: 20 })
    expect(ok("when JUP up 50% sell 25% of JUP").when).toEqual({ kind: "entry", token: JUP, dir: "up", percent: 50 })
    expect(ok("when pnl < -$20 notify").when).toEqual({ kind: "pnl", op: "<", usd: -20, figure: "-$20" })
    // A P&L level's own window, before the level: by the P&L window's names, with today for since midnight.
    expect(ok("when pnl today < -$20 notify").when).toEqual({ kind: "pnl", op: "<", usd: -20, figure: "-$20", window: "midnight" })
    expect(ok("when pnl 24h > $50 notify").when).toMatchObject({ kind: "pnl", op: ">", usd: 50, window: "24h" })
    expect(ok("when pnl session < -$20 notify").when).toMatchObject({ window: "session" })
    expect(ok("when pnl 9:30 < -$20 notify").when).toMatchObject({ window: "09:30" })
    expect(parseTriggerShape("when pnl 25:00 < -$20 notify").ok).toBe(false)
    expect(parseTriggerShape("when pnl week < -$20 notify").ok).toBe(false)
    expect(ok("when kol_mention group smart_money chain solana notify").when).toEqual({ kind: "tape", pattern: "kol_mention", filters: { group: "smart_money", chain: "solana" } })
    expect(ok("when new_ticker mcap > 50k mcap < 200k age < 2h buy $2 of it").when).toEqual({ kind: "tape", pattern: "new_ticker", filters: { minMcapUsd: 50_000, maxMcapUsd: 200_000, maxAgeMinutes: 120 } })
    expect(ok("when mine notify").when).toEqual({ kind: "mine" })
    expect(ok('when mine "whales" buy $1 of it').when).toEqual({ kind: "mine", rule: "whales" })
  })

  test("every schedule, in local time", () => {
    expect(ok("every weekday 09:30 notify").when).toEqual({ kind: "schedule", every: { kind: "days", days: [1, 2, 3, 4, 5], at: "09:30", words: "every weekday" } })
    expect(ok("every monday at 9:05 notify").when).toEqual({ kind: "schedule", every: { kind: "days", days: [1], at: "09:05", words: "every Monday" } })
    expect(ok("every fri 17:00 notify").when).toMatchObject({ every: { days: [5] } })
    expect(ok("every 4h buy $5 of JUP").when).toEqual({ kind: "schedule", every: { kind: "interval", ms: 4 * 3_600_000, text: "4h" } })
    expect(ok("every 30m notify").words).toBe("Every 30 minutes, notify you. Runs each time.")
  })

  test("at HH:MM runs once, at the next HH:MM on this machine's clock, then switches off", () => {
    const t = ok("at 9:05 buy $1 of JUP")
    expect(t.when).toEqual({ kind: "schedule", every: { kind: "once", at: "09:05" } })
    expect(t).toMatchObject({ class: "schedule", name: "at 9:05", expansion: `at 09:05 buy $1 of ${JUP}` })
    expect(t.words).toBe("At 09:05, this machine's time, buy $1 of JUP. Runs once, then switches off.")
    expect(why("at noon notify")).toContain("Give the time as hours and minutes, on a 24-hour clock: at 09:00.")
    expect(why("at 09:00 notify again")).toContain("again is for a level")
  })

  test("every event", () => {
    expect(ok("on fill notify").when).toEqual({ kind: "event", event: "fill" })
    expect(ok("on fill of JUP notify").when).toEqual({ kind: "event", event: "fill", token: JUP })
    expect(ok("on card expired notify").when).toEqual({ kind: "event", event: "card-expired" })
    expect(ok("on replay ended notify").when).toEqual({ kind: "event", event: "replay-ended" })
    const call = ok("on call b5 JUP")
    expect(call).toMatchObject({ class: "event", name: "on call", cooldownMs: DEFAULT_COOLDOWN_MS })
    expect(call.words).toBe("When it's called from outside, buy $5 of JUP. Fires each time, at most every 30 minutes.")
    // How it's called, by its own name.
    expect(ok('on call b5 JUP as "dip"').words).toBe('When `candle-harness trigger "dip"` calls it, buy $5 of JUP. Fires each time, at most every 30 minutes.')
    // A wake's refusal shows the line with the agent it named.
    expect(why("on call wake swing look")).toBe('wake takes what to look at in quotes: wake swing "check the new ticker".')
  })

  test("a rules bot's entry, exit or pause, by its name in quotes", () => {
    expect(ok('on bot "conf small" exited wake agent-b "check its stops"').when).toEqual({ kind: "event", event: "bot", bot: "conf small", what: "exited" })
    const t = ok('on bot "conf" entered notify')
    expect(t).toMatchObject({ class: "event", name: "on bot conf entered" })
    expect(t.words).toBe('When the bot "conf" buys into a position, notify you. Fires each time, at most every 30 minutes.')
    expect(ok('on bot "conf" paused notify').words).toStartWith('When the bot "conf" is paused, notify you.')
    expect(why("on bot conf exited notify")).toContain("on bot names a rules bot in quotes")
    expect(why('on bot "conf" stopped notify')).toBe('on bot "conf" then entered (a position bought), exited (a position sold), paused, or says "<word>" (a code bot\'s own word).')
  })

  test("on bot says: a code bot's own word, quoted or not, made lowercase; a word that isn't one is refused", () => {
    expect(ok('on bot "grid" says "needs-a-look" wake agent-a "look at its spread"').when).toEqual({ kind: "event", event: "bot", bot: "grid", what: "says", word: "needs-a-look" })
    expect(ok("on bot \"grid\" says Halted notify").when).toEqual({ kind: "event", event: "bot", bot: "grid", what: "says", word: "halted" })
    const t = ok('on bot "grid" says "needs-a-look" notify')
    expect(t).toMatchObject({ class: "event", name: "on bot grid says needs-a-look" })
    expect(t.words).toStartWith('When the code bot "grid" says "needs-a-look", notify you.')
    expect(why('on bot "grid" says notify')).toContain('says names the code bot\'s word')
    expect(why('on bot "grid" says "two words" notify')).toContain("one lowercase word")
  })

  test("the actions: a trade, a chain, an alias, notify and wake, with then", () => {
    expect(ok('when JUP < $0.40 then notify "JUP is under 40 cents"').action).toEqual({ kind: "notify", words: "JUP is under 40 cents" })
    expect(ok('when JUP < $0.40 wake agent-b "look at JUP"').action).toEqual({ kind: "wake", agent: "agent-b", words: "look at JUP" })
    const chain = ok("on call sell 50% of JUP; b5 MOON")
    expect(chain.action.kind === "command" && chain.action.command.kind).toBe("chain")
    expect(chain.expansion).toBe(`on call sell 50% of ${JUP}; buy $5 of ${MOON}`)
    expect(ok("every 4h swap 0.1 SOL USDC").expansion).toBe("every 4h swap 0.1 SOL USDC")
    // In paper, `embedded` needs no wallet read; live, the core's wallets topic answers it.
    expect(ok("every 4h buy 0.1 sol of JUP from embedded", { mode: "paper" }).expansion).toBe(`every 4h buy 0.1 sol of ${JUP} from embedded`)
  })

  test("again, a cooldown and a name, in any order", () => {
    const t = ok('when JUP < $0.40 sell 25% of JUP cooldown 2h as "ladder" again')
    expect(t).toMatchObject({ name: "ladder", again: true, cooldownMs: 2 * 3_600_000 })
    expect(t.shape.body).toBe("when JUP < $0.40 sell 25% of JUP")
    expect(t.words).toBe("When JUP's price falls below $0.40, sell 25% of JUP. Fires each time it's crossed back, at most every 2 hours.")
    expect(fullLine({ body: t.shape.body, again: t.again, cooldownMs: t.cooldownMs, name: t.name, defaultName: "JUP < $0.40" })).toBe('when JUP < $0.40 sell 25% of JUP again cooldown 2h as "ladder"')
  })

  test("a rule's name loses its quotes in the trigger's own name, which can't hold one", () => {
    expect(ok('when mine "whales" notify').name).toBe("mine whales")
  })

  test("as <agent> on the trade makes it that agent's trigger", () => {
    expect(ok("every 4h b5 JUP as agent-b")).toMatchObject({ agent: "agent-b", expansion: `every 4h buy $5 of ${JUP} as agent-b` })
    expect(ok("every 4h b5 JUP as agent-b").words).toBe("Every 4 hours, buy $5 of JUP as agent-b. Runs each time.")
  })

  test("it is the token that fired, in a tape trigger or one on your personal signals", () => {
    const t = ok("when new_ticker mcap < 200k buy $2 of it")
    expect(t.expansion).toBe("when new_ticker mcap < 200k buy $2 of it")
    expect(t.action.kind === "command" && t.action.command.kind === "trade" && t.action.command.args.mint).toBe(IT_MINT)
    expect(t.words).toBe("When Hacc's tape shows a new_ticker signal (market cap under $200K), buy $2 of the token that fired. Fires each time, once per token every 30 minutes.")
    expect(why("when JUP < $0.40 buy $1 of it")).toContain("only for a tape trigger or one on your personal signals")
    expect(why("when it < $0.40 sell 50% of JUP")).toContain("it means the token that fired")
  })
})

describe("the expansion means at firing what it meant when saved", () => {
  const LINES = [
    "when JUP < $0.40 sell 50% of JUP",
    "when JUP mcap > 2m sell 1000 of JUP",
    "when JUP down 20% sell 100% of JUP",
    "every day 09:00 b5 JUP",
    "every 4h buy 0.1 sol of JUP from embedded",
    "on call sell 50% of JUP; b5 MOON",
    "on fill of MOON notify",
    'on bot "conf" exited notify',
    'on bot "grid" says "needs-a-look" notify',
    "when new_ticker mcap < 200k age < 60m chain solana buy $2 of it",
    'when mine "whales" buy $1 of it as agent-b',
    "every 30m swap 0.1 SOL USDC",
  ]

  test("each expansion reads back the same, with no names and no aliases", () => {
    for (const line of LINES) {
      const mode = line.includes(" from ") ? "paper" : "live"
      const t = ok(line, { mode })
      const again = resolveTrigger(t.expansion, ctx({ knownTokens: new Map(), aliases: new Map(), mode }))
      expect([line, again.ok && again.value.expansion]).toEqual([line, t.expansion])
      expect([line, again.ok && again.value.agent]).toEqual([line, t.agent])
    }
  })

  test("a trade renders to a line the input line reads to the same trade", () => {
    for (const line of ["buy $5 of JUP", "buy 0.1 sol JUP", "buy 0.5 usdc of MOON as agent-b", "sell 50% of JUP", "sell 1000 MOON from embedded", "swap 25 USDC SOL"]) {
      const mode = line.includes(" from ") ? "paper" : "live"
      const c = parseCommand(line, ctx({ mode }))
      if (c?.kind !== "trade") throw new Error(line)
      const back = parseCommand(renderCommand(c), ctx({ knownTokens: new Map(), mode }))
      expect([line, back?.kind === "trade" && back.args, back?.kind === "trade" && back.agent]).toEqual([line, c.args, c.agent])
    }
  })

  test("an alias changed later doesn't change what the expansion does", () => {
    const t = ok("every day 09:00 b5 JUP")
    expect(ok("every day 09:00 b5 JUP", { aliases: new Map([["b5", "buy $50 of"]]) }).expansion).not.toBe(t.expansion)
    expect(ok(t.expansion, { aliases: new Map([["b5", "buy $50 of"]]) }).expansion).toBe(t.expansion)
  })
})

describe("a line it can't place is refused with why", () => {
  test("the shape", () => {
    expect(parseTriggerShape("sell 50% of JUP").ok).toBe(false)
    expect(why("when JUP < 0.4 sell 50% of JUP")).toBe("A price is in dollars: JUP < $0.40.")
    expect(why("when JUP <= $0.40 sell 50% of JUP")).toBe("Use < or >: JUP < $0.40.")
    expect(why("when JUP drops a lot sell 50% of JUP")).toContain("A level is JUP < $0.40")
    expect(why("when JUP < $0.40")).toBe("Say what it does: a trade, notify, or wake <agent>.")
    expect(why("when JUP down 100% notify")).toContain("under 100%")
    expect(why("every day 9am notify")).toContain("24-hour clock")
    expect(why("every sometimes notify")).toContain("A schedule is day, weekday")
    expect(why("every 30s notify")).toContain("A schedule is day, weekday")
    expect(why("on launch notify")).toContain("An event is fill")
    expect(why("when new_ticker mcap < 200k mcap < 100k notify")).toBe("mcap < is given twice.")
    expect(why("when new_ticker mcap > 200k mcap < 100k notify")).toBe("The market cap filters leave nothing between them.")
    expect(why('when JUP < $0.40 notify "unclosed')).toContain("A quote isn't closed")
    expect(why("when JUP < $0.40 notify JUP is low")).toContain("notify takes its words in quotes")
    expect(why('when JUP < $0.40 sell 50% of JUP as ""')).toContain("can't name a trigger: it's empty")
  })

  test("again and cooldowns only where they mean something", () => {
    expect(why("every 4h notify again")).toContain("again is for a level")
    expect(why("when confluence notify again")).toContain("fires each time already")
    expect(why("when JUP < $0.40 sell 50% of JUP cooldown 1h")).toContain("Add again to re-arm it")
    expect(why("every 4h notify cooldown 1h")).toContain("A schedule runs at each of its times")
    expect(why("when confluence notify cooldown 30s")).toContain("A cooldown is minutes, hours or days")
    expect(ok("when confluence notify cooldown 1m").cooldownMs).toBe(60_000)
  })

  test("the action's kind: trades, sells and swaps only, never a candle command, an owner step or funds out", () => {
    expect(why("when JUP < $0.40 candle keys list")).toContain("candle commands, owner steps and funds out aren't")
    expect(why("when JUP < $0.40 candle vault transfer 1 SOL to x")).toContain("candle commands")
    expect(why("on call sell 50% of JUP; candle keys list")).toContain("Part 2 of the chain runs a candle command")
    expect(why("when JUP < $0.40 kill")).toContain("runs on its own, not from a trigger")
    expect(why("when JUP < $0.40 please sell some")).toContain("isn't a trade the Candle Harness can run")
  })

  test("its tokens, agents and wallets, in the input line's words", () => {
    expect(why("when ORE < $1 notify")).toContain("ORE isn't a token this session has shown")
    expect(why("when ORE < $1 notify", { knownTokens: new Map() })).toContain("The core knows no token names yet")
    expect(why("every 4h sell 50% of ORE")).toContain("The action: ORE isn't a token this session has shown")
    expect(why("when JUP < $0.40 wake agent-z")).toBe("No agent named agent-z to wake. Agents: agent-a, agent-b.")
    expect(why("every 4h b5 JUP as agent-z")).toContain("No agent named agent-z")
    expect(why("on call b5 JUP; sell 50% of MOON as agent-b")).toBe("A trigger trades with one agent's key, and this line names agent-a and agent-b.")
    expect(why("every 4h b5 JUP", { proposer: "agent-z" })).toContain("No agent named agent-z")
    const several = new Map([["MOON", [MOON, JUP]]])
    expect(why("when MOON < $1 notify", { knownTokens: new Map(), severalTokens: several })).toContain("MOON is the name of 2 tokens")
  })
})

test("a line starts like a trigger with when, every or on and more words", () => {
  expect(["when JUP < $1 notify", "every day", "On call x"].map(startsLikeTrigger)).toEqual([true, true, true])
  expect(["when", "sell 50% of JUP", "whenever"].map(startsLikeTrigger)).toEqual([false, false, false])
})

test("the examples in the grammar's own header read", () => {
  for (const line of [
    "when JUP < $0.40 sell 50% of JUP",
    "when JUP > $1 notify",
    "when JUP mcap < 500k notify",
    "when JUP down 20% notify",
    "when JUP up 50% notify",
    "when pnl < -$20 notify",
    "when confluence mcap < 500k age < 60m notify",
    "when kol_mention group smart_money chain solana notify",
    "when mine notify",
    'when mine "whales" notify',
    "every day 09:00 notify",
    "every weekday 09:00 notify",
    "every monday 09:00 notify",
    "every 4h notify",
    "every 30m notify",
    "on fill notify",
    "on fill of JUP notify",
    "on card expired notify",
    "on replay ended notify",
    "on call notify",
    'when JUP < $0.40 notify "JUP is under 40 cents"',
    'when confluence wake agent-a "check the new ticker"',
    "when new_ticker mcap < 200k buy $2 of it",
    'when JUP < $0.40 sell 25% of JUP again cooldown 2h as "ladder"',
  ]) {
    expect([line, read(line).ok]).toEqual([line, true])
  }
})
