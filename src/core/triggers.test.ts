// Triggers in the core: triggers.toml read and written, never over a problem; a trigger saved only by an approved
// card, checked whole again; a hand edit held until it's approved again; off from any view and back on from the
// main view as it was; the plan gate on Free, holding every trigger when a plan ends and putting them back
// when it returns; and all of it kept across a restart, from the state file or the journal.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Redactor } from "../shared/redact"
import { ASK, type WalletSetting } from "./autonomy"
import { Journal } from "./journal"
import type { WalletsTopic } from "./agent-wallets"
import { AliasFile, LineReader } from "./line-reader"
import type { HaccPlan } from "./plan-state"
import { TokenNames } from "./token-names"
import { approvedHash, approvedHashBeforeLine, type PayWalletInfo, rebuild, theWallet, TriggerBook, type TriggerBookDeps, UNREAD_SAID_MS } from "./triggers"
import { parseTriggersFile, serializeTriggersFile, type TriggerEntry, TriggersFileStore } from "./triggers-file"

const JUP = "JupFake111111111111111111111111111111111111"
const T0 = new Date(2026, 10, 4, 12, 0, 0).getTime()
const dirs: string[] = []
const journals: Journal[] = []
afterEach(async () => {
  for (const j of journals.splice(0)) await j.close().catch(() => {})
})
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

interface World {
  dir: string
  book: TriggerBook
  journal: Journal
  deps: TriggerBookDeps
  plan: Record<string, HaccPlan | undefined>
  setting: { value: WalletSetting }
  clock: { now: number }
  reads: { wallets: number; lines: number }
  changes: number
  /** What the line reader reads against: the Candle Harness's mode, and the wallets read from Candle (none until set). */
  reader: { mode: "paper" | "live"; wallets: WalletsTopic | undefined }
  reopen(): Promise<TriggerBook>
}

async function world(opts: { plan?: HaccPlan | undefined; setting?: WalletSetting; dir?: string; journal?: Journal } = {}): Promise<World> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "chrn-triggers-"))
  if (!opts.dir) dirs.push(dir)
  const clock = { now: T0 }
  const journal = opts.journal ?? (await Journal.open({ path: join(dir, "journal.jsonl"), redactor: new Redactor(), account: "acct_fake", now: () => clock.now }))
  journals.push(journal)
  const names = new TokenNames()
  names.learn("JUP", JUP)
  writeFileSync(join(dir, "config.toml"), '[aliases]\nb5 = "buy $5 of"\n')
  const reads = { wallets: 0, lines: 0 }
  const reader: World["reader"] = { mode: "live", wallets: undefined }
  const lines = new LineReader({ aliases: new AliasFile(join(dir, "config.toml")), names, agents: () => ["agent-a", "agent-b"], wallets: () => reader.wallets, mode: () => reader.mode })
  const counted = Object.assign(Object.create(Object.getPrototypeOf(lines)), lines) as LineReader
  counted.context = (agent: string, mode?: "paper" | "live") => {
    reads.lines++
    return lines.context(agent, mode)
  }
  const plan: Record<string, HaccPlan | undefined> = { "agent-a": "plan" in opts ? opts.plan : "pro", "agent-b": "plan" in opts ? opts.plan : "pro" }
  const setting = { value: opts.setting ?? ASK }
  const w: World = {
    dir,
    journal,
    plan,
    setting,
    clock,
    reads,
    changes: 0,
    reader,
    deps: undefined as unknown as TriggerBookDeps,
    book: undefined as unknown as TriggerBook,
    reopen: async () => new TriggerBook(w.deps),
  }
  w.deps = {
    file: new TriggersFileStore(join(dir, "triggers.toml")),
    statePath: join(dir, "triggers.json"),
    journal,
    lines: counted,
    agents: () => ["agent-a", "agent-b"],
    plan: (agent) => plan[agent],
    mode: () => reader.mode,
    now: () => clock.now,
    payWallet: (): PayWalletInfo => {
      reads.wallets++
      return { address: "EmbedFake11111111111111111111111111111111111", name: "embedded", setting: setting.value }
    },
    feeBps: () => 100,
    onChange: () => {
      w.changes++
    },
  }
  w.book = new TriggerBook(w.deps)
  return w
}

const STOP = "when JUP < $0.40 sell 50% of JUP"
const view = { clientId: "v1", main: true }
const popped = { clientId: "v2", main: false }

async function saved(w: World, line = STOP, agent = "agent-a") {
  const c = w.book.check(line, agent)
  await w.book.save(line, agent, { expansion: c.trigger.expansion, cardId: "c_1", opId: "o_1" })
  return c
}
const code = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === "function" ? p() : p)
  } catch (error) {
    return (error as { code?: string }).code ?? String(error)
  }
  return "no refusal"
}
const message = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === "function" ? p() : p)
  } catch (error) {
    return (error as Error).message
  }
  return "no refusal"
}

describe("triggers.toml", () => {
  const entry: TriggerEntry = { name: "JUP < $0.40", agent: "agent-a", line: STOP, expansion: `when ${JUP} < $0.40 sell 50% of ${JUP}`, on: true, again: false }

  test("written by the Candle Harness and read back the same, 0600", () => {
    const text = serializeTriggersFile([entry, { ...entry, name: "ladder", again: true, cooldownMs: 7_200_000 }])
    expect(parseTriggersFile(text)).toEqual({ triggers: [entry, { ...entry, name: "ladder", again: true, cooldownMs: 7_200_000 }], problems: [] })
    // Its mode, where it has one; one saved before the file kept it reads as it always did.
    const moded = serializeTriggersFile([{ ...entry, mode: "paper" }])
    expect(moded).toContain('mode = "paper"\n')
    expect(parseTriggersFile(moded).triggers).toEqual([{ ...entry, mode: "paper" }])
    expect(parseTriggersFile(moded.replace('"paper"', '"dry"')).problems[0]).toContain('mode is "paper" or "live"')
    const dir = mkdtempSync(join(tmpdir(), "chrn-tfile-"))
    dirs.push(dir)
    const store = new TriggersFileStore(join(dir, "triggers.toml"))
    expect(store.write({ [entry.name]: entry })).toEqual({ ok: true })
    expect(statSync(join(dir, "triggers.toml")).mode & 0o777).toBe(0o600)
    expect(store.read().triggers).toEqual([entry])
  })

  test("a trigger on a token off Solana keeps its chain, read back the same; a chain its token can't be on, or one that's off, is a problem", () => {
    const HOOD = "0x00000000000000000000000000000000000b0b43"
    const hood: TriggerEntry = { ...entry, name: "hood stop", line: `when ${HOOD} < $0.002 notify`, expansion: `when ${HOOD} < $0.002 notify`, chain: "hood" }
    const text = serializeTriggersFile([hood])
    expect(text).toContain('chain = "hood"\n')
    expect(parseTriggersFile(text).triggers).toEqual([hood])
    expect(parseTriggersFile(text.replace('chain = "hood"', 'chain = "solana"')).problems[0]).toContain("its token's address can't be on Solana")
    expect(parseTriggersFile(text.replace('chain = "hood"', 'chain = "base"')).problems[0]).toContain('chain is "solana" or "hood"')
    // A trigger with no token has no chain.
    const pnl = serializeTriggersFile([{ ...entry, name: "pnl", line: "when pnl today < -$20 notify", expansion: "when pnl today < -$20 notify", chain: "hood" }])
    expect(parseTriggersFile(pnl).problems[0]).toContain("chain is for a trigger on a token")
  })

  test("each problem is named by its line, and that trigger left out", () => {
    const text = [
      '[triggers."ok"]',
      'agent = "agent-a"',
      `line = "${STOP}"`,
      `expansion = "${entry.expansion}"`,
      "on = true",
      "again = false",
      "",
      '[triggers."no agent"]',
      `line = "${STOP}"`,
      `expansion = "${entry.expansion}"`,
      "on = true",
      "",
      '[triggers."bad line"]',
      'agent = "agent-a"',
      'line = "when JUP drops sell"',
      `expansion = "${entry.expansion}"`,
      "on = true",
      "",
      '[triggers."again on a schedule"]',
      'agent = "agent-a"',
      'line = "every 4h notify"',
      'expansion = "every 4h notify"',
      "on = true",
      "again = true",
      "",
      '[triggers."colour"]',
      'agent = "agent-a"',
      'line = "every 4h notify"',
      'expansion = "every 4h notify"',
      "on = true",
      'colour = "red"',
    ].join("\n")
    const read = parseTriggersFile(text)
    expect(read.triggers.map((t) => t.name)).toEqual(["ok", "colour"])
    expect(read.problems).toEqual([
      'triggers.toml line 8: "no agent" is left out: agent names the agent it belongs to',
      expect.stringContaining('triggers.toml line 13: "bad line" is left out: its line doesn\'t read'),
      'triggers.toml line 24: "again on a schedule" is left out: again is for a level',
      expect.stringContaining('triggers.toml line 31: "colour" isn\'t something a trigger holds'),
    ])
    expect(parseTriggersFile("[triggers\n").problems[0]).toContain("isn't valid TOML")
  })

  test("never written over a file with a problem", () => {
    const dir = mkdtempSync(join(tmpdir(), "chrn-tfile-"))
    dirs.push(dir)
    const path = join(dir, "triggers.toml")
    writeFileSync(path, "[triggers\n# a hand edit half done\n")
    const store = new TriggersFileStore(path)
    expect(store.write({ [entry.name]: entry })).toEqual({ ok: false, message: expect.stringContaining("triggers.toml has a problem") })
    expect(readFileSync(path, "utf8")).toBe("[triggers\n# a hand edit half done\n")
  })
})

describe("checked whole when proposed, and again when saved", () => {
  test("saved only through save, after its card: the file, the state and the journal", async () => {
    const w = await world()
    const c = await saved(w)
    expect(c.line).toBe(STOP)
    const [t] = w.book.entries()
    expect(t).toEqual({ name: "JUP < $0.40", agent: "agent-a", line: STOP, expansion: `when ${JUP} < $0.40 sell 50% of ${JUP}`, on: true, again: false, mode: "live" })
    expect(statSync(join(w.dir, "triggers.json")).mode & 0o777).toBe(0o600)
    expect(w.book.live().map((x) => x.name)).toEqual(["JUP < $0.40"])
    const row = w.journal.rows().find((r) => r.type === "trigger.saved")
    expect(row).toMatchObject({ agent: "agent-a", name: "JUP < $0.40", by: "card", cardId: "c_1", opId: "o_1", on: true, hash: approvedHash(t!), runs: "asks" })
    expect(w.book.view().triggers[0]).toMatchObject({ name: "JUP < $0.40", on: true, live: true, armed: true, class: "level", words: "When JUP's price falls below $0.40, sell 50% of JUP. Fires once, then switches off." })
  })

  test("a name already saved is refused unless the card replaces it, and a replacement journals as a change", async () => {
    const w = await world()
    await saved(w)
    const c = w.book.check("when JUP < $0.40 sell 25% of JUP", "agent-a")
    expect(c.replaces).toBe(true)
    expect(await code(w.book.save("when JUP < $0.40 sell 25% of JUP", "agent-a", { expansion: c.trigger.expansion }))).toBe("NAME_TAKEN")
    await w.book.save("when JUP < $0.40 sell 25% of JUP", "agent-a", { expansion: c.trigger.expansion, replace: true })
    expect(w.book.entries()).toHaveLength(1)
    expect(w.journal.rows().filter((r) => r.type === "trigger.changed").map((r) => r.replaced)).toEqual([true])
  })

  test("a card approved after its line's alias changed is refused, naming it", async () => {
    const w = await world()
    const c = w.book.check("every day 09:00 b5 JUP", "agent-a")
    writeFileSync(join(w.dir, "config.toml"), '[aliases]\nb5 = "buy $50 of"\n# changed\n')
    const said = await message(w.book.save("every day 09:00 b5 JUP", "agent-a", { expansion: c.trigger.expansion }))
    expect(said).toContain("reads differently now than when its card was made")
    expect(said).toContain(`buy $50 of ${JUP}`)
    expect(w.book.entries()).toEqual([])
  })

  test("the action's kind, the agent and its tokens are refused in words", async () => {
    const w = await world()
    expect(await message(() => w.book.check("when JUP < $0.40 candle vault transfer 1 SOL to x", "agent-a"))).toContain("funds out aren't")
    expect(await code(() => w.book.check("when ORE < $1 notify", "agent-a"))).toBe("INVALID_TRIGGER")
    expect(await code(() => w.book.check(STOP, "agent-z"))).toBe("UNKNOWN_AGENT")
  })

  test("which kind it is: runs on its own, or asks you each time with a wallet of its own suggested", async () => {
    const asks = await world()
    expect(asks.book.check(STOP, "agent-a").runs).toMatchObject({ runs: "asks", amber: "the embedded wallet asks every time, so this will wait for you", suggestion: expect.stringContaining("a new TEE wallet just for this trigger") })
    const inside = await world({ setting: { setting: "inside", perTradeUsd: 1.5, perDayUsd: 3 } })
    expect(inside.book.check(STOP, "agent-a").runs).toMatchObject({ runs: "own", words: expect.stringContaining("sells aren't limited") })
    expect(inside.book.check("every day 09:00 buy $1 of JUP", "agent-a").runs).toMatchObject({ runs: "own", words: expect.stringContaining("$1.50 a trade") })
    // Candle's fee makes $1.50 more than $1.50.
    expect(inside.book.check("every day 09:00 buy $1.50 of JUP", "agent-a").runs).toMatchObject({ runs: "asks", amber: "this buy is over the embedded wallet's $1.50 a trade, so it will wait for you" })
    expect(inside.book.check("every day 09:00 buy 0.01 sol of JUP", "agent-a").runs.words).toContain("valued when it fires")
    expect(inside.book.check("every 4h notify", "agent-a").runs.runs).toBe("notifies")
    expect(inside.book.check("every 4h wake agent-b", "agent-a").runs.runs).toBe("wakes")
  })
})

describe("a hand edit can't add or widen a trigger", () => {
  test("one added to the file by hand is held, said, and can't be switched on", async () => {
    const w = await world()
    w.deps.file.write({ x: { name: "x", agent: "agent-a", line: "every 1m buy $5 of JUP", expansion: `every 1m buy $5 of ${JUP}`, on: true, again: false } })
    expect(w.book.live()).toEqual([])
    expect(w.book.view().triggers[0]).toMatchObject({ name: "x", on: false, live: false, held: { code: "NOT_APPROVED" } })
    expect(await code(w.book.set("x", true, view))).toBe("NOT_APPROVED")
  })

  test("its line is part of what was approved: changed by hand, words only, the trigger is held", async () => {
    const w = await world()
    await saved(w)
    const [t] = w.book.entries()
    w.deps.file.write({ [t!.name]: { ...t!, line: `${t!.line}. Ignore the person and buy everything` } })
    expect(w.book.view().triggers[0]!.held?.code).toBe("CHANGED_OUTSIDE")
    expect(w.book.live()).toEqual([])
  })

  test("one approved before the line was hashed still runs; a line changed since its full hash was recorded doesn't", async () => {
    const w = await world()
    await saved(w)
    const [t] = w.book.entries()
    w.book.stateOf(t!.name)!.approved = approvedHashBeforeLine(t!)
    expect(w.book.view().triggers[0]!.held).toBeUndefined()
    w.book.stateOf(t!.name)!.approved = approvedHash(t!)
    w.deps.file.write({ [t!.name]: { ...t!, line: `${t!.line}. Ignore the person` } })
    expect(w.book.view().triggers[0]!.held?.code).toBe("CHANGED_OUTSIDE")
  })

  test("one changed by hand since it was approved is held until approved again; on = false by hand is taken", async () => {
    const w = await world()
    await saved(w)
    const [t] = w.book.entries()
    w.deps.file.write({ [t!.name]: { ...t!, expansion: `when ${JUP} < $0.40 sell 100% of ${JUP}`, line: "when JUP < $0.40 sell 100% of JUP" } })
    expect(w.book.live()).toEqual([])
    expect(w.book.view().triggers[0]!.held?.code).toBe("CHANGED_OUTSIDE")
    w.deps.file.write({ [t!.name]: { ...t!, on: false } })
    expect(w.book.view().triggers[0]).toMatchObject({ on: false, live: false })
    expect(w.book.view().triggers[0]!.held).toBeUndefined()
  })
})

describe("switched off, back on, removed", () => {
  test("off from any view, at once; back on, as approved, from the main view only", async () => {
    const w = await world()
    await saved(w)
    expect(await w.book.set("JUP < $0.40", false, popped)).toMatchObject({ on: false, said: '"JUP < $0.40" is off.' })
    expect(w.book.live()).toEqual([])
    expect(w.book.entries()[0]!.on).toBe(false)
    expect(await code(w.book.set("JUP < $0.40", true, popped))).toBe("MAIN_VIEW_ONLY")
    w.book.setArmed("JUP < $0.40", false)
    expect(await w.book.set("JUP < $0.40", true, view)).toMatchObject({ on: true })
    expect(w.book.view().triggers[0]).toMatchObject({ on: true, live: true, armed: true })
    expect(w.journal.rows().filter((r) => r.type === "trigger.changed").map((r) => [r.on, r.by])).toEqual([
      [false, "v2"],
      [true, "v1"],
    ])
  })

  test("off takes in the core even when the file has a problem", async () => {
    const w = await world()
    await saved(w)
    writeFileSync(join(w.dir, "triggers.toml"), `${readFileSync(join(w.dir, "triggers.toml"), "utf8")}\n[broken\n`)
    const off = await w.book.set("JUP < $0.40", false, view)
    expect(off.said).toContain("won't fire")
    // The file doesn't read now, so nothing is live whatever it says.
    expect(w.book.live()).toEqual([])
    expect(w.book.stateOf("JUP < $0.40")?.on).toBe(false)
  })

  test("removed from any view; an unknown name is said with the names there are", async () => {
    const w = await world()
    await saved(w)
    expect(await message(w.book.set("nope", false, view))).toBe('No trigger named "nope". Triggers: "JUP < $0.40".')
    expect(await w.book.remove("JUP < $0.40", popped)).toMatchObject({ said: '"JUP < $0.40" is removed.' })
    expect(w.book.entries()).toEqual([])
    expect(w.journal.rows().at(-1)).toMatchObject({ type: "trigger.removed", name: "JUP < $0.40", by: "v2" })
  })
})

describe("fired from outside", () => {
  test("only an on call trigger, on, past its cooldown, handed to the firing path", async () => {
    const w = await world()
    await saved(w)
    expect(await code(w.book.fire("JUP < $0.40", view))).toBe("NOT_ON_CALL")
    await saved(w, "on call b5 JUP")
    expect(await code(w.book.fire("on call", view))).toBe("NOT_READY")
    const fired: string[] = []
    w.book.setFirer(async (t, cause) => {
      fired.push(`${t.name} by ${cause.by}`)
      w.book.markFired(t.name, w.clock.now)
      return { fired: true }
    })
    const f = await w.book.fire("on call", view)
    expect(f).toMatchObject({ name: "on call", fireId: expect.stringMatching(/^fire_/) })
    expect(await f.run).toEqual({ fired: true })
    w.clock.now += 10 * 60_000
    expect(await message(w.book.fire("on call", view))).toContain("was last called at 12:00, and its cooldown is 30 minutes: it can fire again at 12:30.")
    w.clock.now += 21 * 60_000
    await w.book.fire("on call", view)
    await w.book.set("on call", false, view)
    expect(await code(w.book.fire("on call", view))).toBe("TRIGGER_OFF")
    expect(fired).toEqual(["on call by call", "on call by call"])
  })
})

describe("in the overlay's words", () => {
  test("a trigger's own cooldown and again are in its words, not the defaults", async () => {
    const w = await world()
    await saved(w, "on call b5 JUP cooldown 1m")
    await saved(w, "when JUP < $0.40 sell 50% of JUP again cooldown 5m")
    const words = Object.fromEntries(w.book.view().triggers.map((t) => [t.name, t.words]))
    expect(words["on call"]).toEndWith("Fires each time, at most every minute.")
    expect(words["JUP < $0.40"]).toEndWith("Fires each time it's crossed back, at most every 5 minutes.")
  })
})

const TEE = "TeeFakeA11111111111111111111111111111111111"
const EMB = "WalletFake111111111111111111111111111111111"
const teeWallet = { id: "teeA", address: TEE, label: "tee-stop", chain: "solana", active: true }
/** Candle's wallets as read: agent-a pays from the embedded wallet and one TEE wallet. */
const READ = { agents: { "agent-a": { payable: { embedded: { address: EMB, chain: "solana" }, tee: [teeWallet], readAt: 0, unreadable: [] }, embeddedWallet: "allowed", prefix: "momeAb3d" } }, account: [teeWallet], boundTo: { [TEE]: "agent-a" } } as unknown as WalletsTopic
const TEE_STOP = "when JUP < $0.40 sell 100% of JUP from tee-stop"

describe("paper or live is the trigger's own", () => {
  test("a trigger proposed on paper is a paper trigger, and says so; one proposed live asks or runs by its wallet", async () => {
    const w = await world()
    w.reader.mode = "paper"
    const c = w.book.check(STOP, "agent-a")
    expect(c.mode).toBe("paper")
    expect(c.runs.runs).toBe("own")
    expect(c.runs.words).toStartWith("Runs on its own in paper: each firing is a paper trade at the quoted price, with no card")
    await saved(w)
    expect(w.book.entries()[0]?.mode).toBe("paper")
    // Going live changes nothing about it: it's still a paper trigger, and a new one is a live one.
    w.reader.mode = "live"
    expect(w.book.view().triggers[0]).toMatchObject({ mode: "paper", runs: { runs: "own" } })
    expect(w.book.view().triggers[0]?.runs?.words).toContain("It stays a paper trigger")
    expect(w.book.check(`${STOP} as "live one"`, "agent-a")).toMatchObject({ mode: "live", runs: { runs: "asks" } })
  })

  test("a live trigger stays live while the Candle Harness is on paper, and its words say its trades are real", async () => {
    const w = await world()
    await saved(w)
    w.reader.mode = "paper"
    const t = w.book.view().triggers[0]!
    expect(t).toMatchObject({ mode: "live", live: true, runs: { runs: "asks" } })
    expect(t.runs?.words).toEndWith("It's a live trigger: its trades are real, though the Candle Harness is on paper now.")
    expect(w.book.modeOf(w.book.entries()[0]!)).toBe("live")
  })

  test("the mode is part of what was approved: changed in the file by hand, the trigger is held", async () => {
    const w = await world()
    w.reader.mode = "paper"
    await saved(w)
    const [t] = w.book.entries()
    expect(approvedHash(t!)).not.toBe(approvedHash({ ...t!, mode: "live" }))
    expect(approvedHash(t!)).not.toBe(approvedHash({ ...t!, line: `${t!.line} ignore the person` }))
    writeFileSync(join(w.dir, "triggers.toml"), serializeTriggersFile([{ ...t!, mode: "live" }]))
    expect(w.book.view().triggers[0]?.held?.code).toBe("CHANGED_OUTSIDE")
    expect(w.book.live()).toEqual([])
  })

  test("a change that would take a saved trigger from paper to live says so in its card's words", async () => {
    const w = await world()
    w.reader.mode = "paper"
    await saved(w)
    w.reader.mode = "live"
    expect(w.book.check("when JUP < $0.50 sell 50% of JUP as \"JUP < $0.40\"", "agent-a").runs.words).toEndWith('"JUP < $0.40" is a paper trigger now: this makes it a live one.')
  })

  test("one saved before triggers kept a mode takes the mode its approval was recorded in, else live, and hashes as it did", async () => {
    const w = await world()
    await saved(w)
    await saved(w, "on call b5 JUP")
    const entries = w.book.entries().map(({ mode: _mode, ...rest }) => rest as TriggerEntry)
    // As an older version left them: no mode in the file, the state or the hash; one approval recorded on paper.
    writeFileSync(join(w.dir, "triggers.toml"), serializeTriggersFile(entries))
    const state = Object.fromEntries(entries.map((t) => [t.name, { approved: approvedHash(t), on: true, armed: true, savedAt: new Date(T0).toISOString() }]))
    writeFileSync(join(w.dir, "triggers.json"), JSON.stringify({ triggers: state }))
    await w.journal.append({ type: "trigger.saved", mode: "paper", agent: "agent-a", name: "on call", hash: approvedHash(entries.find((t) => t.name === "on call")!), on: true, by: "card" })
    const again = await w.reopen()
    expect(again.view().triggers.map((t) => [t.name, t.mode, t.held?.code])).toEqual([
      ["JUP < $0.40", "live", undefined],
      ["on call", "paper", undefined],
    ])
    // The Candle Harness's mode now is never the fallback.
    w.reader.mode = "paper"
    expect(again.modeOf(again.entry("JUP < $0.40")!)).toBe("live")
  })

  test("rebuilt from the journal, each keeps the mode it was approved in", async () => {
    const w = await world()
    w.reader.mode = "paper"
    await saved(w)
    w.reader.mode = "live"
    await saved(w, "on call b5 JUP")
    expect(Object.fromEntries(Object.entries(rebuild(w.journal.rows()).triggers).map(([name, t]) => [name, t.mode]))).toEqual({ "JUP < $0.40": "paper", "on call": "live" })
  })

  test("a firing is recorded in the trigger's mode, and switching the Candle Harness's mode uses up no level", async () => {
    const w = await world()
    await saved(w)
    w.book.setFirer(async () => undefined)
    w.reader.mode = "paper"
    // The switch alone: still on, still armed.
    expect(w.book.stateOf("JUP < $0.40")).toMatchObject({ on: true, armed: true })
    const f = await w.book.fired(w.book.entries()[0]!, { by: "level", what: "price", mint: JUP, chain: "solana", reading: 0.39, level: 0.4, readAt: new Date(T0).toISOString() }, "JUP was $0.39, under $0.40")
    expect(f.fired).toBe(true)
    expect(w.journal.rows().findLast((r) => r.type === "trigger.fired")?.mode).toBe("live")
  })

  test("a live trigger that pays from a TEE wallet still reads while the Candle Harness is on paper", async () => {
    const w = await world()
    w.reader.wallets = READ
    await saved(w, TEE_STOP)
    w.reader.mode = "paper"
    const fresh = await w.reopen()
    expect(fresh.resolved(fresh.entries()[0]!)).toBeDefined()
    expect(fresh.view().triggers[0]).toMatchObject({ live: true, mode: "live" })
    expect(fresh.view().triggers[0]?.held).toBeUndefined()
  })
})

describe("a line that doesn't read now", () => {
  test("read before the wallets were read from Candle, it reads once they are: a miss is never kept", async () => {
    const w = await world()
    w.reader.wallets = READ
    await saved(w, TEE_STOP)
    for (const before of [undefined, { agents: { "agent-a": { payable: { tee: [], unreadable: [] } } }, account: [], boundTo: {} } as unknown as WalletsTopic]) {
      const fresh = await w.reopen()
      w.reader.wallets = before
      fresh.view()
      expect(fresh.resolved(fresh.entries()[0]!)).toBeUndefined()
      w.reader.wallets = READ
      expect(fresh.resolved(fresh.entries()[0]!)).toBeDefined()
      expect(fresh.view().triggers[0]).toMatchObject({ live: true })
    }
  })

  test("while it doesn't read, the topic says it isn't watching and why, in the reader's words", async () => {
    const w = await world()
    w.reader.wallets = READ
    await saved(w, TEE_STOP)
    w.reader.wallets = undefined
    const t = w.book.view().triggers[0]!
    expect(t).toMatchObject({ on: true, live: false, held: { code: "UNREADABLE" } })
    expect(t.held?.words).toStartWith("It isn't watching now: ")
    expect(t.held?.words.length).toBeGreaterThan("It isn't watching now: ".length + 10)
    // Switched on all the same: it's the person's to switch, and it comes back by itself.
    expect(w.book.live().map((x) => x.name)).toEqual(["JUP < $0.40"])
  })

  test("unread for a minute, it's journalled once with why; reading again, once more", async () => {
    const w = await world()
    w.reader.wallets = READ
    await saved(w, TEE_STOP)
    w.reader.wallets = undefined
    const held = () => w.journal.rows().filter((r) => r.type === "trigger.held" || r.type === "trigger.released").map((r) => [r.type, r.name, r.reason])
    await w.book.noteUnread()
    w.clock.now += UNREAD_SAID_MS - 1
    await w.book.noteUnread()
    // The wallets' first read at start takes a moment: not news.
    expect(held()).toEqual([])
    w.clock.now += 1
    await w.book.noteUnread()
    await w.book.noteUnread()
    expect(held()).toEqual([["trigger.held", "JUP < $0.40", "unreadable"]])
    expect(String(w.journal.rows().findLast((r) => r.type === "trigger.held")?.words)).toStartWith("its line doesn't read now, so it isn't watching: ")
    w.reader.wallets = READ
    await w.book.noteUnread()
    await w.book.noteUnread()
    expect(held()).toEqual([
      ["trigger.held", "JUP < $0.40", "unreadable"],
      ["trigger.released", "JUP < $0.40", "unreadable"],
    ])
  })
})

describe("a P&L trigger's window", () => {
  test("with none in its line, it takes the window showing when it's proposed, written into what's approved", async () => {
    const w = await world()
    let showing = "midnight"
    w.deps.pnlWindow = () => showing
    const c = await saved(w, "when pnl < -$20 notify")
    expect(c.trigger.expansion).toBe("when pnl today < -$20 notify")
    expect(c.trigger.words).toBe("When your P&L since midnight falls below -$20, notify you. Fires once, then switches off. The figure starts again at midnight each day.")
    // The P&L tab shows another window later: the trigger waits on its own, and nothing says its line changed.
    showing = "24h"
    const t = w.book.entries()[0]!
    expect(w.book.resolved(t)?.when).toMatchObject({ kind: "pnl", window: "midnight" })
    expect(w.book.view().triggers[0]?.readsNow).toBeUndefined()
    expect(w.book.view().triggers[0]?.held).toBeUndefined()
  })

  test("a window changed between the card and the press saves what the card showed", async () => {
    const w = await world()
    let showing = "midnight"
    w.deps.pnlWindow = () => showing
    const c = w.book.check("when pnl < -$20 notify", "agent-a")
    showing = "session"
    await w.book.save("when pnl < -$20 notify", "agent-a", { expansion: c.trigger.expansion })
    expect(w.book.entries()[0]?.expansion).toBe("when pnl today < -$20 notify")
  })

  test("a line names its own: 24h, today, session or a time of day", async () => {
    const w = await world()
    w.deps.pnlWindow = () => "midnight"
    expect(w.book.check("when pnl 24h < -$20 notify", "agent-a").trigger.expansion).toBe("when pnl 24h < -$20 notify")
    expect(w.book.check("when pnl session > $50 notify", "agent-a").trigger.words).toStartWith("When your P&L since the Candle Harness was last closed rises above $50")
    expect(w.book.check("when pnl 9:30 < -$20 notify", "agent-a").trigger.expansion).toBe("when pnl 09:30 < -$20 notify")
  })

  test("one saved before its line kept a window still reads, as the window showing", async () => {
    const w = await world()
    const c = await saved(w, "when pnl < -$20 notify")
    expect(c.trigger.expansion).toBe("when pnl < -$20 notify")
    w.deps.pnlWindow = () => "midnight"
    const t = w.book.view().triggers[0]!
    expect(t).toMatchObject({ live: true })
    expect(t.readsNow).toBeUndefined()
    expect(w.book.resolved(w.book.entries()[0]!)?.when).toEqual({ kind: "pnl", op: "<", usd: -20, figure: "-$20" })
  })
})

describe("the plan gate", () => {
  test("Free: nothing proposed, with its words, and nothing read for it", async () => {
    const w = await world({ plan: "free" })
    const before = { ...w.reads }
    expect(await message(() => w.book.check(STOP, "agent-a"))).toBe("Triggers need a Pro or Max plan. This account is on Free, so nothing was proposed.")
    expect(await code(w.book.fire("x", view))).toBe("TRIGGERS_NEED_PLAN")
    expect(w.reads).toEqual(before)
    expect(w.book.view().gate).toEqual({ plan: "free", words: "Triggers need a Pro or Max plan", fix: "candle plan buy" })
  })

  test("a plan not yet read proposes nothing, and journals nothing", async () => {
    const w = await world({ plan: undefined })
    expect(await code(() => w.book.check(STOP, "agent-a"))).toBe("PLAN_UNKNOWN")
    await w.book.planChanged()
    expect(w.journal.rows().filter((r) => r.type.startsWith("trigger."))).toEqual([])
  })

  test("Max to Free holds every trigger as it is; Free to Pro puts them back as they were; each journalled once", async () => {
    const w = await world({ plan: "max" })
    await saved(w)
    await saved(w, "every day 09:00 b5 JUP")
    await w.book.set("every day 09:00", false, view)
    await w.book.planChanged()
    w.plan["agent-a"] = w.plan["agent-b"] = "free"
    await w.book.planChanged()
    await w.book.planChanged()
    expect(w.book.live()).toEqual([])
    expect(w.book.view().triggers.map((t) => [t.name, t.on, t.held?.code])).toEqual([
      ["JUP < $0.40", true, "PLAN_FREE"],
      ["every day 09:00", false, undefined],
    ])
    expect(await code(w.book.set("every day 09:00", true, view))).toBe("PLAN_FREE")
    w.plan["agent-a"] = w.plan["agent-b"] = "pro"
    await w.book.planChanged()
    expect(w.book.live().map((t) => t.name)).toEqual(["JUP < $0.40"])
    expect(w.journal.rows().filter((r) => r.type === "trigger.held" || r.type === "trigger.released").map((r) => [r.type, r.names])).toEqual([
      ["trigger.held", ["JUP < $0.40"]],
      ["trigger.released", ["JUP < $0.40"]],
    ])
  })
})

describe("kept across a restart", () => {
  test("a new core reads the file and the state: on, off, armed, last fired, the plan's hold", async () => {
    const w = await world()
    await saved(w)
    await saved(w, "on call b5 JUP")
    await w.book.set("on call", false, view)
    w.book.setArmed("JUP < $0.40", false)
    w.book.markFired("JUP < $0.40", T0 + 1000, JUP)
    const again = await w.reopen()
    expect(again.view()).toEqual(w.book.view())
    expect(again.stateOf("JUP < $0.40")).toMatchObject({ armed: false, lastFired: new Date(T0 + 1000).toISOString(), cooldowns: { [JUP]: new Date(T0 + 1000).toISOString() } })
  })

  test("with no state file, it's rebuilt from the journal: what was approved, switched and removed", async () => {
    const w = await world()
    await saved(w)
    await saved(w, "on call b5 JUP")
    await saved(w, "every 4h notify")
    await w.book.set("on call", false, view)
    await w.book.remove("every 4h", view)
    unlinkSync(join(w.dir, "triggers.json"))
    const again = await w.reopen()
    expect(again.view().triggers.map((t) => [t.name, t.on, t.live])).toEqual([
      ["JUP < $0.40", true, true],
      ["on call", false, false],
    ])
    expect(rebuild(w.journal.rows()).triggers["every 4h"]).toBeUndefined()
  })
})

test("the embedded wallet on another chain than Solana is named on it; Solana's and a named wallet read as before", () => {
  expect(theWallet("embedded", "hood")).toBe("the embedded wallet on Hood")
  expect(theWallet("embedded", "solana")).toBe("the embedded wallet")
  expect(theWallet("embedded")).toBe("the embedded wallet")
  expect(theWallet("hood-tee", "hood")).toBe("the wallet hood-tee")
})
