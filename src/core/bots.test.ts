// Rules bots in the core: bots.toml read and written, its definitions as Hacc's own tables, never over a problem;
// a bot saved only by an approved card, bound by its hash and checked whole again; a hand edit holding its
// entries while its exits sell as approved; narrowing at once and wider refused; pause from anywhere, stop and
// resume the person's; the plan gate holding entries on Free; and all of it kept across a restart, from the
// state file or the journal.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readDefinition } from "../shared/definition"
import { Redactor } from "../shared/redact"
import { ASK } from "./autonomy"
import { BotBook, type BotBookDeps, type BotProposal, rebuild } from "./bots"
import { type BotEntry, BotsFileStore, parseBotsFile, serializeBotsFile } from "./bots-file"
import { Journal } from "./journal"
import { queryJournal } from "./journal-query"
import type { HaccPlan } from "./plan-state"

const TEE = "TeeFake1111111111111111111111111111111111111"
const T0 = new Date(2026, 10, 5, 12, 0, 0).getTime()
const dirs: string[] = []
const journals: Journal[] = []
afterEach(async () => {
  for (const j of journals.splice(0)) await j.close().catch(() => {})
})
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const DEFINITION = {
  chain: "solana",
  entry: { source: "pattern", pattern: "confluence", filters: { max_mcap_usd: 500_000, max_age_minutes: 60 } },
  exit: { take_profit_pct: 100, stop_loss_pct: 40, max_hold_hours: 24 },
  sizing: { usd_per_trade: 2, max_concurrent: 4 },
}
const proposal = (patch: Partial<BotProposal> = {}): BotProposal => ({ name: "confluence-small", definition: structuredClone(DEFINITION), run: { agent: "agent-a", wallet: "embedded", mode: "paper" }, ...patch })

interface World {
  dir: string
  book: BotBook
  journal: Journal
  deps: BotBookDeps
  plan: Record<string, HaccPlan | undefined>
  clock: { now: number }
  file: string
  changes: number
}

async function world(opts: { plan?: HaccPlan } = {}): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "chrn-bots-"))
  dirs.push(dir)
  const clock = { now: T0 }
  const journal = await Journal.open({ path: join(dir, "journal.jsonl"), redactor: new Redactor(), account: "acct_fake", now: () => clock.now })
  journals.push(journal)
  const plan: Record<string, HaccPlan | undefined> = { "agent-a": opts.plan ?? "pro", "agent-b": opts.plan ?? "pro" }
  const w = { dir, journal, plan, clock, file: join(dir, "bots.toml"), changes: 0 } as World
  w.deps = {
    file: new BotsFileStore(w.file),
    statePath: join(dir, "bots.json"),
    journal,
    agents: () => ["agent-a", "agent-b"],
    plan: (agent) => plan[agent],
    mode: () => "live",
    now: () => clock.now,
    payWallet: (agent, wallet) => (wallet === "embedded" ? { address: "EmbFake1111111111111111111111111111111111111", name: "embedded", setting: ASK } : wallet === TEE || wallet === "tee-one" ? { address: TEE, name: "tee-one", setting: ASK } : undefined),
    onChange: () => void w.changes++,
  }
  w.book = new BotBook(w.deps)
  return w
}

/** A refusal's code: the words are the person's, the code what a caller reads. */
const refusal = (p: Promise<unknown>) => p.then(() => "no refusal", (e: { code?: string }) => e.code)
const refusalOf = (f: () => unknown) => {
  try {
    f()
    return "no refusal"
  } catch (e) {
    return (e as { code?: string }).code
  }
}

async function saved(w: World, p = proposal()) {
  const c = w.book.check(p, p.run.agent)
  return w.book.save(p, p.run.agent, { hash: c.hash, cardId: "card_1" })
}

describe("bots.toml", () => {
  test("a definition round-trips as Hacc's own tables: filters, a trailing exit, hours, sizing rules", () => {
    const d = readDefinition({
      ...DEFINITION,
      entry: { source: "pattern", pattern: "new_ticker", filters: { min_usd: 500, hours_et: [9, 17], venues: ["pump"] } },
      exit: { take_profit_pct: 50, trailing: { arm_multiple: 2, drop_pct: 25 } },
      sizing: { usd_per_trade: 2, max_concurrent: 4, base_usd: 2, max_usd: 6, rules: [{ when: { mcap_at_entry: { lt: 100_000 } }, mult: 2 }] },
    })
    if (!d.ok) throw new Error(d.message)
    const bot: BotEntry = { name: "tickers 2", agent: "agent-a", wallet: TEE, mode: "live", state: "paused", maxSlippageBps: 300, definition: d.definition }
    const text = serializeBotsFile([bot])
    expect(text).toContain('[bots."tickers 2".definition.entry.filters]')
    expect(text).toContain("hours_et = [9, 17]")
    expect(text).toContain("rules = [{ when = { mcap_at_entry = { lt = 100000 } }, mult = 2 }]")
    expect(parseBotsFile(text)).toEqual({ bots: [bot], code: [], problems: [] })
  })

  test("a problem is named by its line, in Hacc's words for a definition, and that bot is left out", () => {
    const read = readDefinition(DEFINITION)
    if (!read.ok) throw new Error(read.message)
    const good = serializeBotsFile([{ name: "a", agent: "agent-a", wallet: "embedded", mode: "paper", state: "on", definition: read.definition }])
    const bad = good.replace('pattern = "confluence"', 'pattern = "distribution"').replace('state = "on"', 'state = "on"\ncolour = "red"')
    const f = parseBotsFile(bad)
    expect(f.bots).toEqual([])
    expect(f.problems[0]).toMatch(/^bots\.toml line \d+: "colour" isn't something a bot holds \(agent, wallet, mode, state, maxSlippageBps, definition\)$/)
    expect(f.problems[1]).toMatch(/^bots\.toml line \d+: "a" is left out: its definition doesn't read \(entry\.pattern: /)
    expect(parseBotsFile("[bots.x]\nagent = 1\n").problems).toEqual(['bots.toml line 1: "x" is left out: agent names the agent it belongs to; wallet is "embedded" or the address of the wallet it pays from; mode is "paper" or "live"; state is "on", "paused" or "stopped"'])
    expect(parseBotsFile("bots = [").problems[0]).toStartWith("bots.toml isn't valid TOML")
  })

  test("written whole and 0600, and never over a file with a problem", async () => {
    const w = await world()
    await saved(w)
    expect(statSync(w.file).mode & 0o777).toBe(0o600)
    const before = readFileSync(w.file, "utf8")
    writeFileSync(w.file, `${before}\n[oops`)
    expect(w.deps.file.write({})).toMatchObject({ ok: false })
    expect(await refusal(w.book.pause("confluence-small", { clientId: "v", how: "view" }))).toBe("UNKNOWN_BOT")
    expect(readFileSync(w.file, "utf8")).toBe(`${before}\n[oops`)
  })
})

describe("made only by an approved card", () => {
  test("saved on the card's hash, on, version 1, journalled with the whole definition", async () => {
    const w = await world()
    expect(await saved(w)).toEqual({ name: "confluence-small", replaced: false, version: 1 })
    const view = w.book.view().bots[0]!
    expect(view).toMatchObject({ kind: "rules", name: "confluence-small", agent: "agent-a", wallet: "embedded", paysFrom: "embedded", mode: "paper", state: "on", entries: true, exits: true, version: 1, versions: 1 })
    expect(view.words).toBe("Buys $2 when several tracked wallets buy the same token, under $500K market cap and under 1 hour old. Sells at +100%, at -40%, or after 24 hours. At most 4 at once.")
    const row = w.journal.rows().find((r) => r.type === "bot.saved")!
    expect(row).toMatchObject({ agent: "agent-a", name: "confluence-small", version: 1, by: "card", cardId: "card_1", run: { agent: "agent-a", wallet: "embedded", mode: "paper" } })
    expect(row.definition).toEqual(DEFINITION)
  })

  test("a card whose bot reads differently now saves nothing; a name taken needs the card to say it replaces", async () => {
    const w = await world()
    const c = w.book.check(proposal(), "agent-a")
    const wider = proposal({ definition: { ...DEFINITION, sizing: { usd_per_trade: 20, max_concurrent: 4 } } })
    expect(await refusal(w.book.save(wider, "agent-a", { hash: c.hash }))).toBe("BOT_CHANGED")
    expect(w.book.entries()).toEqual([])
    await saved(w)
    const again = w.book.check(proposal(), "agent-a")
    expect(again.replaces).toBe(true)
    expect(await refusal(w.book.save(proposal(), "agent-a", { hash: again.hash }))).toBe("NAME_TAKEN")
    expect(await w.book.save(proposal(), "agent-a", { hash: again.hash, replace: true })).toMatchObject({ replaced: true, version: 2 })
  })

  test("checked whole: Hacc's own words, what can't run live, another agent's, a wallet it can't pay from, a TEE wallet by name", async () => {
    const w = await world()
    expect(() => w.book.check(proposal({ definition: { ...DEFINITION, chain: "eth" } }), "agent-a")).toThrow("Hacc's lab wouldn't take this definition: chain:")
    expect(() => w.book.check(proposal({ definition: { ...DEFINITION, exit: { exit_on_signal: true } } }), "agent-a")).toThrow("This can be backtested, not run as a bot: exit.exit_on_signal:")
    expect(() => w.book.check(proposal(), "agent-b")).toThrow("agent-b can't make one for agent-a")
    expect(refusalOf(() => w.book.check(proposal({ run: { agent: "agent-a", wallet: "NopeFake111111111111111111111111111111111111", mode: "live" } }), "agent-a"))).toBe("WALLET_CANT_PAY")
    expect(refusalOf(() => w.book.check(proposal({ name: '"quoted"' }), "agent-a"))).toBe("INVALID_BOT_NAME")
    expect(w.book.check(proposal({ run: { agent: "agent-a", wallet: "tee-one", mode: "live" } }), "agent-a")).toMatchObject({ run: { wallet: TEE }, paysFrom: "tee-one" })
  })
})

describe("a hand edit", () => {
  test("a bot changed by hand takes no entries, its exits sell as approved; one added by hand runs nothing; a pause by hand is taken", async () => {
    const w = await world()
    await saved(w)
    const text = readFileSync(w.file, "utf8")
    writeFileSync(w.file, text.replace("usd_per_trade = 2", "usd_per_trade = 50"))
    const [held] = w.book.view().bots
    expect(held).toMatchObject({ state: "on", entries: false, exits: true, held: { code: "CHANGED_OUTSIDE" } })
    expect(w.book.approvedVersion("confluence-small")?.definition.sizing.usd_per_trade).toBe(2)
    expect(w.book.keepingUp()).toHaveLength(1)
    expect(await refusal(w.book.narrow("confluence-small", { definition: DEFINITION }, { clientId: "v", how: "view" }))).toBe("CHANGED_OUTSIDE")

    writeFileSync(w.file, `${text}\n${serializeBotsFile([{ ...w.book.entry("confluence-small")!, name: "sneaky", mode: "live" }]).split("\n").slice(4).join("\n")}`)
    expect(w.book.view().bots.find((b) => b.name === "sneaky")).toMatchObject({ entries: false, exits: false, held: { code: "NOT_APPROVED" } })

    writeFileSync(w.file, text.replace('state = "on"', 'state = "paused"'))
    expect(w.book.view().bots[0]).toMatchObject({ state: "paused", entries: false, exits: true, stateWords: "paused: no new entries, its exits still sell, set in bots.toml" })
    expect(w.book.view().bots[0]!.held).toBeUndefined()
  })
})

describe("narrowed at once, wider a card", () => {
  test("the agent narrows its own bot: a new version, approved as it, journalled with what narrowed; its state kept", async () => {
    const w = await world()
    await saved(w)
    await w.book.pause("confluence-small", { clientId: "h", how: "agent", agent: "agent-a" })
    const narrower = { ...DEFINITION, exit: { ...DEFINITION.exit, stop_loss_pct: 25 } }
    expect(await w.book.narrow("confluence-small", { definition: narrower }, { clientId: "h", how: "agent", agent: "agent-a" })).toEqual({ name: "confluence-small", version: 2, narrowed: ["a stop at -25%, from -40%"], said: '"confluence-small" is narrowed: a stop at -25%, from -40%.' })
    expect(w.book.view().bots[0]).toMatchObject({ state: "paused", version: 2, versions: 2 })
    expect(w.book.heldBy(w.book.entry("confluence-small")!)).toBeUndefined()
    expect(w.journal.rows().at(-1)).toMatchObject({ type: "bot.changed", how: "agent", changedBy: "agent-a", narrowed: ["a stop at -25%, from -40%"] })
  })

  test("wider, the same, another agent's, or a field that can't run live: refused, and the bot unchanged", async () => {
    const w = await world()
    await saved(w)
    const by = { clientId: "v", how: "view" as const }
    await expect(w.book.narrow("confluence-small", { definition: { ...DEFINITION, sizing: { usd_per_trade: 5, max_concurrent: 4 } } }, by)).rejects.toThrow('That\'s wider than "confluence-small" was approved: a stake of $5 is over its $2.')
    expect(await refusal(w.book.narrow("confluence-small", { definition: DEFINITION, maxSlippageBps: 500 }, by))).toBe("WIDER")
    expect(await refusal(w.book.narrow("confluence-small", { definition: DEFINITION }, by))).toBe("NO_CHANGE")
    expect(await refusal(w.book.narrow("confluence-small", { definition: DEFINITION, maxSlippageBps: 50 }, { clientId: "h", how: "agent", agent: "agent-b" }))).toBe("NOT_ITS_AGENT")
    const scored = { ...DEFINITION, entry: { ...DEFINITION.entry, filters: { ...DEFINITION.entry.filters, min_score_1h: 3 } } }
    expect(await refusal(w.book.narrow("confluence-small", { definition: scored }, by))).toBe("NOT_LIVE")
    expect(w.book.view().bots[0]).toMatchObject({ version: 1, versions: 1 })
  })
})

describe("what isn't a narrowing, though it reads like one", () => {
  test("a filter's list emptied takes the filter away: refused by the reader, the bot and its file unchanged", async () => {
    const w = await world()
    const filtered = { ...DEFINITION, entry: { source: "pattern", pattern: "large_move", filters: { wallet_ids: [12, 40] } } }
    const p = proposal({ name: "trusted", definition: filtered })
    await w.book.save(p, "agent-a", { hash: w.book.check(p, "agent-a").hash, cardId: "card_1" })
    for (const filters of [{ wallet_ids: [] }, { wallet_ids: [12, 40], groups: [] }, { wallet_ids: [12, 40], venues: [] }]) {
      expect(await refusal(w.book.narrow("trusted", { definition: { ...filtered, entry: { ...filtered.entry, filters } } }, { clientId: "h", how: "agent", agent: "agent-a" }))).toBe("INVALID_DEFINITION")
    }
    // Dropping the list outright is wider, as before.
    expect(await refusal(w.book.narrow("trusted", { definition: { ...filtered, entry: { ...filtered.entry, filters: {} } } }, { clientId: "h", how: "agent", agent: "agent-a" }))).toBe("WIDER")
    expect(w.book.entry("trusted")!.definition.entry).toMatchObject({ filters: { wallet_ids: [12, 40] } })
    expect(w.book.view().bots[0]).toMatchObject({ version: 1 })
    expect(refusalOf(() => w.book.check(proposal({ name: "open", definition: { ...filtered, entry: { ...filtered.entry, filters: { wallet_ids: [] } } } }), "agent-a"))).toBe("INVALID_DEFINITION")
  })

  test("a slippage bound: tightened as far as the route's default at once; under it refused for a card; under the floor refused outright", async () => {
    const w = await world()
    const p = proposal({ run: { agent: "agent-a", wallet: "embedded", mode: "paper", maxSlippageBps: 300 } })
    await w.book.save(p, "agent-a", { hash: w.book.check(p, "agent-a").hash, cardId: "card_1" })
    const by = { clientId: "h", how: "agent" as const, agent: "agent-a" }
    expect((await w.book.narrow("confluence-small", { definition: DEFINITION, maxSlippageBps: 100 }, by)).narrowed).toEqual(["slippage 1%, from 3%"])
    await expect(w.book.narrow("confluence-small", { definition: DEFINITION, maxSlippageBps: 50 }, by)).rejects.toThrow("a slippage bound of 0.5% is under the route's 1%, and a bound that tight can make its sells fail")
    // The person's own narrowing is held to the same: a bound that binds the exits is pressed on a card.
    expect(await refusal(w.book.narrow("confluence-small", { definition: DEFINITION, maxSlippageBps: 50 }, { clientId: "v", how: "view" }))).toBe("WIDER")
    for (const bps of [0, 9, 2.5, 10_001]) expect([bps, await refusal(w.book.narrow("confluence-small", { definition: DEFINITION, maxSlippageBps: bps }, by))]).toEqual([bps, "INVALID_SLIPPAGE"])
    expect(refusalOf(() => w.book.check(proposal({ name: "zero", run: { agent: "agent-a", wallet: "embedded", mode: "paper", maxSlippageBps: 0 } }), "agent-a"))).toBe("INVALID_SLIPPAGE")
    // On a card, a bound under the default is the person's to approve.
    expect(w.book.check(proposal({ run: { agent: "agent-a", wallet: "embedded", mode: "paper", maxSlippageBps: 50 } }), "agent-a").run.maxSlippageBps).toBe(50)
    expect(w.book.entry("confluence-small")!.maxSlippageBps).toBe(100)
  })

  test("exits that would sell an open position now: refused as a flatten, the bot unchanged", async () => {
    const w = await world()
    await saved(w)
    const asked: unknown[] = []
    w.book.setSellsNow((name, was, next) => {
      asked.push([name, was?.max_hold_hours, next?.max_hold_hours])
      return 2
    })
    const shorter = { ...DEFINITION, exit: { ...DEFINITION.exit, max_hold_hours: 1 } }
    await expect(w.book.narrow("confluence-small", { definition: shorter }, { clientId: "h", how: "agent", agent: "agent-a" })).rejects.toThrow("Its new exits would sell 2 of its open positions now. That's a flatten, and a card for you to press.")
    expect(asked).toEqual([["confluence-small", 24, 1]])
    expect(w.book.view().bots[0]).toMatchObject({ version: 1 })
    w.book.setSellsNow(() => 0)
    expect((await w.book.narrow("confluence-small", { definition: shorter }, { clientId: "h", how: "agent", agent: "agent-a" })).version).toBe(2)
  })
})

describe("pause, stop, resume", () => {
  test("pause by anyone; stop and resume the person's, from the main view; resume refused while a hand edit holds it", async () => {
    const w = await world()
    await saved(w)
    const name = "confluence-small"
    expect(await w.book.pause(name, { clientId: "h", how: "agent", agent: "agent-a" })).toMatchObject({ state: "paused" })
    expect(w.book.view().bots[0]!.stateWords).toBe("paused: no new entries, its exits still sell, by agent-a at 12:00")
    expect(await refusal(w.book.resume(name, { clientId: "h", main: true, how: "agent" }))).toBe("PERSON_ONLY")
    expect(await refusal(w.book.resume(name, { clientId: "p", main: false }))).toBe("MAIN_VIEW_ONLY")
    expect(await refusal(w.book.stop(name, { clientId: "p", main: false }))).toBe("MAIN_VIEW_ONLY")
    expect(await w.book.stop(name, { clientId: "m", main: true })).toMatchObject({ state: "stopped" })
    expect(w.book.view().bots[0]).toMatchObject({ entries: false, exits: false })
    expect(w.book.keepingUp()).toEqual([])
    // Pausing a stopped bot would let its exits sell again: it says so, and leaves it stopped.
    expect(await w.book.pause(name, { clientId: "v", how: "view" })).toMatchObject({ state: "stopped" })
    w.clock.now += 60_000
    expect(await w.book.resume(name, { clientId: "m", main: true })).toMatchObject({ state: "on" })
    expect(w.book.stateOf(name)!.onSince).toBe(new Date(T0 + 60_000).toISOString())
    expect(readFileSync(w.file, "utf8")).toContain('state = "on"')
    writeFileSync(w.file, readFileSync(w.file, "utf8").replace("max_concurrent = 4", "max_concurrent = 9").replace('state = "on"', 'state = "paused"'))
    expect(await refusal(w.book.resume(name, { clientId: "m", main: true }))).toBe("CHANGED_OUTSIDE")
    expect(w.journal.rows().filter((r) => r.type.startsWith("bot.")).map((r) => r.type)).toEqual(["bot.saved", "bot.paused", "bot.stopped", "bot.resumed"])
  })

  test("flatten waits for the bot's book; removing leaves its positions, or sells them first", async () => {
    const w = await world()
    await saved(w)
    expect(await refusal(w.book.flatten("confluence-small", { clientId: "m", main: true }))).toBe("NOT_READY")
    expect(await refusal(w.book.remove("confluence-small", "flatten", { clientId: "m", main: true }))).toBe("NOT_READY")
    expect(w.book.entries()).toHaveLength(1)
    const sold: string[] = []
    w.book.setFlattener(async (bot) => (sold.push(bot.name), { said: "Sold 2 positions." }))
    expect(await w.book.remove("confluence-small", "flatten", { clientId: "m", main: true })).toEqual({ name: "confluence-small", said: '"confluence-small" is removed. Sold 2 positions.' })
    expect(sold).toEqual(["confluence-small"])
    expect(w.book.entries()).toEqual([])
    expect(w.journal.rows().at(-1)).toMatchObject({ type: "bot.removed", positions: "flatten" })
  })
})

describe("the plan", () => {
  test("Free: nothing proposed, the topic says so; a plan that ends holds entries with exits still selling; one that returns puts them back", async () => {
    const w = await world({ plan: "free" })
    expect(w.book.view().gate).toEqual({ plan: "free", words: "Bots need a Pro or Max plan", fix: "candle plan buy" })
    expect(refusalOf(() => w.book.check(proposal(), "agent-a"))).toBe("BOTS_NEED_PLAN")
    w.plan["agent-a"] = w.plan["agent-b"] = "max"
    await w.book.planChanged()
    await saved(w)
    w.plan["agent-a"] = w.plan["agent-b"] = "free"
    await w.book.planChanged()
    expect(w.book.view().bots[0]).toMatchObject({ entries: false, exits: true, held: { code: "PLAN_FREE" } })
    expect(w.book.keepingUp()).toHaveLength(1)
    await w.book.planChanged()
    w.plan["agent-a"] = w.plan["agent-b"] = "pro"
    await w.book.planChanged()
    expect(w.book.view().bots[0]).toMatchObject({ entries: true, exits: true })
    expect(w.journal.rows().filter((r) => r.type === "bot.held" || r.type === "bot.released").map((r) => [r.type, r.names])).toEqual([
      ["bot.held", ["confluence-small"]],
      ["bot.released", ["confluence-small"]],
    ])
  })
})

describe("a restart", () => {
  test("from the state file, and from the journal alone: the same bots, versions, states and plan hold", async () => {
    const w = await world()
    await saved(w)
    await saved(w, proposal({ name: "tee-bot", run: { agent: "agent-b", wallet: TEE, mode: "live", maxSlippageBps: 300 } }))
    await w.book.narrow("confluence-small", { definition: { ...DEFINITION, sizing: { usd_per_trade: 1, max_concurrent: 4 } } }, { clientId: "v", how: "view" })
    await w.book.pause("tee-bot", { clientId: "v", how: "view" })
    await w.book.stop("confluence-small", { clientId: "m", main: true })
    w.book.setLastSignal("tee-bot", { id: 41, at: new Date(T0).toISOString() })
    const before = w.book.view()
    expect(new BotBook(w.deps).view()).toEqual(before)
    unlinkSync(w.deps.statePath)
    const fromJournal = new BotBook(w.deps).view()
    // The last signal read isn't journalled: the stream reads on from its own cursor.
    expect(fromJournal).toEqual({ ...before, bots: before.bots.map(({ lastSignal: _l, ...b }) => b) })
    expect(rebuild(w.journal.rows()).bots["confluence-small"]!.versions.map((v) => v.n)).toEqual([1, 2])
  })
})

describe("the Journal", () => {
  test("each bot row in words, with who did it, under bots", async () => {
    const w = await world()
    await saved(w)
    await w.book.narrow("confluence-small", { definition: { ...DEFINITION, exit: { ...DEFINITION.exit, stop_loss_pct: 25 } } }, { clientId: "h", how: "agent", agent: "agent-a" })
    await w.book.pause("confluence-small", { clientId: "h", how: "agent", agent: "agent-a" })
    await w.book.stop("confluence-small", { clientId: "m", main: true })
    await w.book.resume("confluence-small", { clientId: "m", main: true })
    w.plan["agent-a"] = w.plan["agent-b"] = "free"
    await w.book.planChanged()
    await w.book.remove("confluence-small", "leave", { clientId: "m", main: true })
    const page = await queryJournal({ kinds: ["bots"] }, { memory: () => w.journal.rows(), tail: w.journal.tail, path: w.journal.path, redactor: new Redactor(), symbolOf: () => undefined })
    expect(page.entries.map((e) => e.text).reverse()).toEqual([
      'you approved agent-a\'s bot "confluence-small" (paper): Buys $2 when several tracked wallets buy the same token, under $500K market cap and under 1 hour old. Sells at +100%, at -40%, or after 24 hours. At most 4 at once.',
      'agent-a narrowed the bot "confluence-small": a stop at -25%, from -40%',
      'agent-a paused the bot "confluence-small": no new entries, its exits still sell',
      'you stopped the bot "confluence-small": nothing trades, and its positions are left to you',
      'you put the bot "confluence-small" back on, as it was approved',
      'entries held: "confluence-small", since the plan is Free now: Bots need a Pro or Max plan to enter, and their exits still sell',
      'you removed the bot "confluence-small", leaving its positions in the wallet',
    ])
  })
})

test("bots.toml changed in the same instant as its last read, keeping its size, is read again", () => {
  const dir = mkdtempSync(join(tmpdir(), "chrn-bots-"))
  dirs.push(dir)
  const path = join(dir, "bots.toml")
  const store = new BotsFileStore(path)
  const one = (perTradeUsd: number) =>
    `[bots."quick"]\nkind = "code"\nagent = "a"\nwallet = "embedded"\nmode = "paper"\nstate = "on"\nfolder = "${dir}"\ncommand = ["bun", "run", "bot.ts"]\nperTradeUsd = ${perTradeUsd}\nperDayUsd = 10\nmaxOpen = 1\n`
  writeFileSync(path, one(2))
  const at = new Date()
  utimesSync(path, at, at)
  expect(store.read().code[0]).toMatchObject({ name: "quick" })
  const before = JSON.stringify(store.read())
  // The same size, the same inode and the same modified time: a timestamp too coarse to tell the two writes apart.
  writeFileSync(path, one(3))
  utimesSync(path, at, at)
  expect(statSync(path).size).toBe(one(2).length)
  expect(JSON.stringify(store.read())).not.toBe(before)
})
