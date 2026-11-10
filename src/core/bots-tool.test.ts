// harness_bots: the card's words (the bot, how its buys and exits run, its worst case, its backtest), with a wallet of its
// own led with where the bot would share a wallet or its wallet asks; nothing saved before the press, and the press
// saving exactly what the card bound; a narrowing at once and anything wider, or going live, a card; pause at once,
// flatten a card; a woken turn reads, pauses and narrows, nothing more; Free proposes nothing; a bot from a tape
// trigger or a saved strategy; and a card a restart cut off, read back.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readDefinition, type Sizing } from "../shared/definition"
import { Redactor } from "../shared/redact"
import { ASK, type WalletSetting } from "./autonomy"
import { BotBook } from "./bots"
import { BotsFileStore } from "./bots-file"
import { type Backtest, type BotCardInput, BotsTool, backtestFromJournal, botRecent, botSkips, botRuns, largestStake, readBotCard, runBotCard, strategyFrom, worstWords } from "./bots-tool"
import { Journal, type JournalRow } from "./journal"
import { AliasFile, LineReader } from "./line-reader"
import type { HaccPlan } from "./plan-state"
import { TokenNames } from "./token-names"
import type { FaceClient } from "./tool-face"
import { TriggerBook } from "./triggers"
import { TriggersFileStore } from "./triggers-file"

const TEE = "TeeFake1111111111111111111111111111111111111"
const EMBEDDED = "EmbFake1111111111111111111111111111111111111"
const JUP = "JupFake111111111111111111111111111111111111"
const T0 = Date.UTC(2026, 10, 6, 12, 0, 0)
const INSIDE: WalletSetting = { setting: "inside", perTradeUsd: 3, perDayUsd: 30 }
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
const def = (patch: Record<string, unknown> = {}) => ({ ...structuredClone(DEFINITION), ...patch })

interface Options {
  plan?: HaccPlan
  embedded?: WalletSetting
  tee?: WalletSetting
  /** Others who pay from the TEE wallet. */
  teeShared?: string[]
  woken?: string
  backtest?: Backtest
  lab?: boolean
}

async function world(o: Options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "chrn-botstool-"))
  dirs.push(dir)
  const journal = await Journal.open({ path: join(dir, "journal.jsonl"), redactor: new Redactor(), account: "acct_fake", now: () => T0 })
  journals.push(journal)
  const plan = () => o.plan ?? "pro"
  const payWallet = (_agent: string, wallet: string) =>
    wallet === "embedded" || wallet === EMBEDDED ? { address: EMBEDDED, name: "embedded", setting: o.embedded ?? ASK } : wallet === TEE || wallet === "tee-one" ? { address: TEE, name: "tee-one", setting: o.tee ?? INSIDE } : undefined
  const book = new BotBook({
    file: new BotsFileStore(join(dir, "bots.toml")),
    statePath: join(dir, "bots.json"),
    journal,
    agents: () => ["agent-a", "agent-b"],
    plan,
    mode: () => "live",
    now: () => T0,
    payWallet,
    onChange: () => {},
  })
  const names = new TokenNames()
  names.learn("JUP", JUP)
  const config = join(dir, "config.toml")
  writeFileSync(config, "")
  const triggers = new TriggerBook({
    file: new TriggersFileStore(join(dir, "triggers.toml")),
    statePath: join(dir, "triggers.json"),
    journal,
    lines: new LineReader({ aliases: new AliasFile(config), names, agents: () => ["agent-a", "agent-b"], wallets: () => undefined, mode: () => "live" }),
    agents: () => ["agent-a", "agent-b"],
    plan,
    mode: () => "live",
    now: () => T0,
    payWallet: () => ({ address: EMBEDDED, name: "embedded", setting: ASK }),
    feeBps: () => 25,
    botNames: () => book.entries().map((b) => b.name),
    onChange: () => {},
  })
  const proposed: { client: FaceClient; card: BotCardInput; reason?: string }[] = []
  const open: Record<string, Record<string, unknown>[]> = {}
  const tool = new BotsTool({
    book,
    triggers,
    bookOf: (name) => ({ open: open[name] ?? [], closed: 0, realizedUsd: 0, valued: true }),
    recent: () => ({ events: [] }),
    payWallet,
    feeBps: () => 25,
    sharedWith: (agent, wallet, bot) => (wallet === "embedded" ? ["you and every agent"] : (o.teeShared ?? []).filter((a) => a !== agent && a !== bot)),
    ownWallet: () => [{ label: "a TEE wallet of its own", line: "candle vault promote --to-key PREFIXxx --label agent-a-bot --from " }],
    backtestOf: () => o.backtest,
    lab: () => o.lab ?? false,
    strategy: async (_agent, id) => (id === 173 ? strategyFrom(JSON.parse(readFileSync("test/fixtures/hacc-recorded/change-strategy-read.json", "utf8")).answer, 173) : { ok: false, code: "HACC_NOT_FOUND", message: "Hacc refused: not found." }),
    propose: async (client, card, reason) => {
      proposed.push({ client, card, ...(reason ? { reason } : {}) })
      return `op_${proposed.length}`
    },
    wokenBy: (tokenId) => (tokenId === "woken" ? (o.woken ?? "dip") : undefined),
  })
  return { dir, journal, book, triggers, tool, proposed, open }
}

const agentA: FaceClient = { clientId: "h1", role: "harness", agent: "agent-a", tokenId: "turn" }
const woken: FaceClient = { ...agentA, tokenId: "woken" }

/** Proposes a bot and saves it as its card's press would. */
async function made(w: Awaited<ReturnType<typeof world>>, o: { name?: string; mode?: "paper" | "live"; wallet?: string; definition?: unknown } = {}) {
  const out = await w.tool.call(agentA, { action: "propose", name: o.name ?? "conf", definition: o.definition ?? def(), wallet: o.wallet ?? "embedded", mode: o.mode ?? "paper" })
  expect(out).toEqual({ card: `op_${w.proposed.length}` })
  const card = w.proposed.at(-1)!.card
  expect(await runBotCard(w.book, { params: card.params as unknown as Record<string, unknown>, cardId: "card_x", opId: `op_${w.proposed.length}` })).toMatchObject({ state: "succeeded" })
  return card
}

describe("what a bot's card says", () => {
  test("its largest stake and worst case: every rule that raises it holding at once, capped by max_usd", () => {
    const s: Sizing = { usd_per_trade: 2, max_concurrent: 4, base_usd: 3, rules: [{ when: { mcap_at_entry: { lt: 100_000 } }, mult: 2 }, { when: { mcap_at_entry: { lt: 50_000 } }, add: 1 }, { when: { mcap_at_entry: { gt: 1e6 } }, mult: 0.5 }] }
    expect(largestStake(s)).toBe(9)
    expect(largestStake({ ...s, max_usd: 5 })).toBe(5)
    expect(worstWords(s)).toBe("At worst 4 positions of up to $9.00 each are open at once: $36.00 at risk, plus Candle's fee.")
    expect(worstWords({ usd_per_trade: 2, max_concurrent: 1 })).toBe("At worst one position of up to $2.00 is open at a time, plus Candle's fee.")
  })

  test("how its trades run: paper with no card; live through the wallet's figures, its exits always without a card", () => {
    const sizing: Sizing = { usd_per_trade: 2, max_concurrent: 4 }
    expect(botRuns({ mode: "paper" }, sizing, undefined, 25)).toMatchObject({ kind: "paper", entries: expect.stringContaining("paper trade with no card") })
    const asks = botRuns({ mode: "live" }, sizing, { address: EMBEDDED, name: "embedded", setting: ASK }, 25)
    expect(asks).toMatchObject({ kind: "asks", entries: expect.stringContaining("the embedded wallet asks every time"), exits: "Its exits sell without a card on any wallet: you approve them now, with the bot.", amber: "the embedded wallet asks every time, so each of its buys will wait for you" })
    expect(botRuns({ mode: "live" }, sizing, { address: TEE, name: "tee-one", setting: INSIDE }, 25)).toMatchObject({ kind: "own", entries: expect.stringContaining("$3.00 a trade and $30.00 a day") })
    // $2 with Candle's 0.25% fee is $2.005, over a $2.00 figure.
    expect(botRuns({ mode: "live" }, sizing, { address: TEE, name: "tee-one", setting: { setting: "inside", perTradeUsd: 2, perDayUsd: 30 } }, 25)).toMatchObject({ kind: "asks", entries: expect.stringContaining("$2.01 with Candle's fee, is over the wallet tee-one's $2.00 a trade") })
    expect(botRuns({ mode: "live" }, sizing, undefined, 25).kind).toBe("unknown")
  })

  test("a backtest of exactly this definition, from the journal's replays; another definition's isn't", () => {
    const read = readDefinition(DEFINITION)
    if (!read.ok) throw new Error(read.message)
    const row = (seq: number, r: Record<string, unknown>) => ({ seq, at: "2026-11-05T10:00:00.000Z", mode: "live", ...r }) as JournalRow
    const rows = [
      // The same definition, written in another order: the same backtest.
      row(1, { type: "hacc.change", view: "run_replay", jobId: 7, definition: { sizing: DEFINITION.sizing, exit: DEFINITION.exit, entry: DEFINITION.entry, chain: "solana" }, from: "2026-11-01T00:00:00Z", to: "2026-11-03T00:00:00Z" }),
      row(2, { type: "hacc.change", view: "run_replay", jobId: 8, definition: def({ sizing: { usd_per_trade: 5, max_concurrent: 4 } }) }),
      row(3, { type: "hacc.replay", jobId: 7, status: "done", verdict: "pass", trades: 14, pnlUsd: 3.2, drawdownPct: 12 }),
      row(4, { type: "hacc.replay", jobId: 8, status: "done", verdict: "fail", trades: 3 }),
    ]
    const b = backtestFromJournal(rows, read.definition)
    expect(b).toEqual({ what: "Hacc's replay 7 of this exact definition", verdict: "pass", trades: 14, pnlUsd: 3.2, drawdownPct: 12, from: "2026-11-01T00:00:00Z", to: "2026-11-03T00:00:00Z" })
    const other = readDefinition(def({ exit: { take_profit_pct: 50 } }))
    expect(other.ok && backtestFromJournal(rows, other.definition)).toBeUndefined()
  })

  test("a new paper bot: a card that saves nothing before the press, then exactly what it bound", async () => {
    const w = await world({ backtest: { what: "Hacc's replay 7 of this exact definition", verdict: "pass", trades: 14, pnlUsd: 3.2, drawdownPct: 12 } })
    expect(await w.tool.call(agentA, { action: "propose", name: "conf", definition: def() })).toMatchObject({ ok: false, code: "ASK_FIRST", message: expect.stringContaining("which wallet it pays from and whether it runs on paper or live") })
    expect(await w.tool.call(agentA, { action: "propose", name: "conf", definition: def(), wallet: "embedded", mode: "paper" }, "the confluence idea")).toEqual({ card: "op_1" })
    expect(w.book.entries()).toEqual([])
    const { card, reason } = w.proposed[0]!
    expect(reason).toBe("the confluence idea")
    expect(card.title).toBe('NEW BOT "conf"')
    expect(card.spec).toMatchObject({
      name: "conf",
      mode: "paper",
      words: "Buys $2 when several tracked wallets buy the same token, under $500K market cap and under 1 hour old. Sells at +100%, at -40%, or after 24 hours. At most 4 at once.",
      runs: { kind: "paper" },
      worst: "At worst 4 positions of up to $2.00 each are open at once: $8.00 at risk, plus Candle's fee.",
      backtest: expect.stringMatching(/^Hacc's replay 7 of this exact definition: pass, 14 trades, P&L \+\$3\.20, drawdown 12\.0%\. A backtest is a model of the past/),
      differs: expect.stringContaining("Hacc's backtest buys at its first price"),
    })
    // A paper bot isn't steered to a wallet of its own: nothing real is at stake.
    expect(card.warning).toBeUndefined()
    expect(card.fills).toBeUndefined()
    expect(card.params).toMatchObject({ action: "save", name: "conf", proposer: "agent-a", replace: false, proposal: { run: { agent: "agent-a", wallet: "embedded", mode: "paper" } } })
    await runBotCard(w.book, { params: card.params as unknown as Record<string, unknown>, cardId: "card_1", opId: "op_1" })
    expect(w.book.entries().map((b) => [b.name, b.agent, b.mode, b.state])).toEqual([["conf", "agent-a", "paper", "on"]])
    expect(w.book.stateOf("conf")!.approved).toBe((card.params as { hash: string }).hash)
    // A restart that cut the card off reads it back: saved as it said.
    expect(readBotCard(w.book, w.journal.rows(), { params: card.params as unknown as Record<string, unknown>, startedAt: T0 })).toMatchObject({ state: "succeeded" })
  })

  test("a live bot on a shared wallet, or one that asks, leads with a wallet of its own; on its own TEE wallet inside limits, it doesn't", async () => {
    const shared = await world({ embedded: INSIDE })
    await shared.tool.call(agentA, { action: "propose", name: "conf", definition: def(), wallet: "embedded", mode: "live" })
    expect(shared.proposed[0]!.card).toMatchObject({
      spec: { runs: { kind: "own" }, mode: "live" },
      warning: "The embedded wallet is shared with you and every agent. A wallet of its own is the better way: the bot can lose only what that wallet holds, and its figures are the bot's alone.",
      fills: [{ label: "a TEE wallet of its own" }],
    })
    const asks = await world({ tee: ASK })
    await asks.tool.call(agentA, { action: "propose", name: "conf", definition: def(), wallet: "tee-one", mode: "live" })
    expect(asks.proposed[0]!.card).toMatchObject({ spec: { runs: { kind: "asks" } }, warning: expect.stringMatching(/^The wallet tee-one asks every time, so each of its buys will wait for you\. A wallet of its own/), fills: [{}] })
    const own = await world({ tee: INSIDE })
    await own.tool.call(agentA, { action: "propose", name: "conf", definition: def(), wallet: TEE, mode: "live", maxSlippageBps: 500 })
    const card = own.proposed[0]!.card
    expect(card.warning).toBeUndefined()
    expect(card.fills).toBeUndefined()
    expect(card.paysFrom).toBe("tee-one")
    expect(card.slippage).toEqual({ words: "its own slippage bound: 5%, looser than the route's 0.5%", looser: true })
    expect(card.spec.backtest).toBe("Backtests need Max.")
    const max = await world({ lab: true })
    await max.tool.call(agentA, { action: "propose", name: "conf", definition: def(), wallet: "embedded", mode: "paper" })
    expect(max.proposed[0]!.card.spec.backtest).toBe("No backtest of this exact definition yet: hacc_lab's run_replay runs one.")
  })

  test("what can be backtested and not run is refused in words, and a name taken or unknown", async () => {
    const w = await world()
    expect(await w.tool.call(agentA, { action: "propose", name: "sig", definition: def({ entry: { source: "trade_signal", min_confidence: 0.7 } }), wallet: "embedded", mode: "paper" })).toMatchObject({ ok: false, code: "NOT_LIVE", message: expect.stringContaining("This can be backtested, not run as a bot: entry.source:") })
    expect(await w.tool.call(agentA, { action: "propose", name: "sig", definition: def({ exit: { exit_on_signal: true } }), wallet: "embedded", mode: "paper" })).toMatchObject({ ok: false, code: "NOT_LIVE", message: expect.stringContaining("exit.exit_on_signal") })
    expect(await w.tool.call(agentA, { action: "propose", name: "sig", definition: { chain: "solana" }, wallet: "embedded", mode: "paper" })).toMatchObject({ ok: false, code: "INVALID_DEFINITION" })
    expect(w.proposed).toEqual([])
    await made(w)
    expect(await w.tool.call(agentA, { action: "propose", name: "conf", definition: def(), wallet: "embedded", mode: "paper" })).toMatchObject({ ok: false, code: "NAME_TAKEN" })
    expect(await w.tool.call(agentA, { action: "propose", name: "nope", replace: true, mode: "live" })).toMatchObject({ ok: false, code: "UNKNOWN_BOT" })
  })
})

describe("changing a bot", () => {
  test("narrower at once, said and journalled; wider a card; going live a card titled so, live only on the press", async () => {
    const w = await world()
    await made(w)
    const narrower = def({ sizing: { usd_per_trade: 1, max_concurrent: 2 }, exit: { take_profit_pct: 100, stop_loss_pct: 25, max_hold_hours: 24 } })
    const at = await w.tool.call(agentA, { action: "propose", name: "conf", replace: true, definition: narrower })
    expect(at).toMatchObject({ ok: true, body: { done: expect.stringMatching(/^Changed "conf" at once, since it only narrows it: /), version: 2 } })
    expect(w.book.entry("conf")!.definition.sizing).toEqual({ usd_per_trade: 1, max_concurrent: 2 })
    expect(w.journal.rows().filter((r) => r.type === "bot.changed").map((r) => [r.how, r.changedBy])).toEqual([["agent", "agent-a"]])
    expect(await w.tool.call(agentA, { action: "propose", name: "conf", replace: true, definition: narrower })).toMatchObject({ ok: true, body: { done: 'That\'s what "conf" already runs, so nothing changed.' } })

    // Wider: a card, and nothing changes before its press.
    const before = w.proposed.length
    expect(await w.tool.call(agentA, { action: "propose", name: "conf", replace: true, definition: def() })).toEqual({ card: `op_${before + 1}` })
    expect(w.proposed.at(-1)!.card).toMatchObject({ title: 'CHANGE BOT "conf"', spec: { replaces: true }, params: { replace: true } })
    // Its face says what changes, either way.
    expect((w.proposed.at(-1)!.card as { spec: { changes?: string } }).spec.changes).toBe("a stop at -40%, from -25%; a stake of $2, from $1; at most 4 at once, from 2 at once")
    expect(w.book.entry("conf")!.definition.sizing.usd_per_trade).toBe(1)

    // Live from paper: the run settings kept but the mode, on a card of its own.
    await w.tool.call(agentA, { action: "propose", name: "conf", replace: true, mode: "live" })
    const live = w.proposed.at(-1)!.card
    expect(live).toMatchObject({ title: 'TAKE BOT "conf" LIVE', spec: { live: true, mode: "live" }, params: { proposal: { run: { mode: "live", wallet: "embedded" } } } })
    expect(w.book.entry("conf")!.mode).toBe("paper")
    await runBotCard(w.book, { params: live.params as unknown as Record<string, unknown>, cardId: "card_live", opId: "op_live" })
    expect(w.book.entry("conf")!.mode).toBe("live")
  })

  test("pause at once, one or all of yours; another agent's isn't yours; resuming is the person's", async () => {
    const w = await world()
    await made(w)
    await made(w, { name: "news" })
    const b = { ...agentA, clientId: "h2", agent: "agent-b" }
    expect(await w.tool.call(b, { action: "pause", name: "conf" })).toMatchObject({ ok: false, code: "NOT_ITS_AGENT" })
    expect(await w.tool.call(b, { action: "pause", all: true })).toMatchObject({ ok: true, body: { done: "None of your bots is on, so nothing changed." } })
    expect(await w.tool.call(agentA, { action: "pause", all: true })).toMatchObject({ ok: true, body: { done: expect.stringContaining('"conf" is paused'), resume: expect.stringContaining("Only the person") } })
    expect(w.book.entries().map((x) => w.book.runState(x))).toEqual(["paused", "paused"])
    expect(await w.tool.call(agentA, { action: "propose", name: "conf", replace: true, definition: def({ sizing: { usd_per_trade: 1, max_concurrent: 4 } }) })).toMatchObject({ ok: true })
    // Narrowing a paused bot keeps it paused.
    expect(w.book.runState(w.book.entry("conf")!)).toBe("paused")
  })

  test("flatten is a card naming what it sells; with nothing open, nothing is proposed", async () => {
    const w = await world()
    await made(w)
    expect(await w.tool.call(agentA, { action: "flatten", name: "conf" })).toMatchObject({ ok: true, body: { done: '"conf" holds no open position, so there\'s nothing to sell.' } })
    w.open.conf = [{ token: "JUP" }, { token: "BONK" }]
    const before = w.proposed.length
    expect(await w.tool.call(agentA, { action: "flatten", name: "conf", reason: "you asked to get out" })).toEqual({ card: `op_${before + 1}` })
    expect(w.proposed.at(-1)).toMatchObject({ reason: "you asked to get out", card: { title: 'FLATTEN BOT "conf"', params: { action: "flatten", name: "conf" }, spec: { flatten: expect.stringContaining("now, at market, on paper: JUP, BONK") } } })
    // A restart that cut it off before any exit was journalled: nothing sold.
    const params = w.proposed.at(-1)!.card.params as unknown as Record<string, unknown>
    expect(readBotCard(w.book, w.journal.rows(), { params, startedAt: T0 })).toMatchObject({ state: "failed", error: { code: "NOT_FLATTENED" } })
    await w.journal.append({ type: "bot.exiting", mode: "live", agent: "agent-a", name: "conf", reason: "flatten", exitId: "exit_1", position: "p1", mint: JUP })
    expect(readBotCard(w.book, w.journal.rows(), { params, startedAt: T0 })).toMatchObject({ state: "succeeded" })
  })
})

describe("who may do what", () => {
  test("a woken turn reads, pauses and narrows; a new bot, a wider one, going live and flatten are the person's", async () => {
    const w = await world()
    await made(w)
    expect(await w.tool.call(woken, { action: "read" })).toMatchObject({ ok: true })
    expect(await w.tool.call(woken, { action: "propose", name: "other", definition: def(), wallet: "embedded", mode: "paper" })).toMatchObject({ ok: false, code: "WOKEN_TURN" })
    expect(await w.tool.call(woken, { action: "propose", name: "conf", replace: true, mode: "live" })).toMatchObject({ ok: false, code: "WOKEN_TURN" })
    expect(await w.tool.call(woken, { action: "flatten", name: "conf" })).toMatchObject({ ok: false, code: "WOKEN_TURN" })
    expect(await w.tool.call(woken, { action: "propose", name: "conf", replace: true, definition: def({ sizing: { usd_per_trade: 1, max_concurrent: 4 } }) })).toMatchObject({ ok: true })
    expect(await w.tool.call(woken, { action: "pause", name: "conf" })).toMatchObject({ ok: true })
  })

  test("a change of exits that would sell what the bot holds now is a flatten: a card, and refused in a woken turn", async () => {
    const w = await world()
    await made(w)
    // The exits' answer: a hold under an hour sells its one open position on the next check.
    w.book.setSellsNow((_name, _was, next) => (next?.max_hold_hours !== undefined && next.max_hold_hours < 1 ? 1 : 0))
    const short = def({ exit: { take_profit_pct: 100, stop_loss_pct: 40, max_hold_hours: 0.5 } })
    expect(await w.tool.call(woken, { action: "propose", name: "conf", replace: true, definition: short })).toMatchObject({ ok: false, code: "WOKEN_TURN" })
    expect(w.book.entry("conf")!.definition.exit!.max_hold_hours).toBe(24)
    // Asked for by the person, it's a card that says first what it sells.
    expect(await w.tool.call(agentA, { action: "propose", name: "conf", replace: true, definition: short })).toEqual({ card: "op_2" })
    expect(w.proposed.at(-1)!.card.spec.changes).toStartWith("its new exits would sell its open position now; a hold of at most 30 minutes, from 24 hours")
    expect(w.book.entry("conf")!.definition.exit!.max_hold_hours).toBe(24)
    // A shorter hold that sells nothing now still takes at once, in a woken turn too.
    const half = def({ exit: { take_profit_pct: 100, stop_loss_pct: 40, max_hold_hours: 12 } })
    expect(await w.tool.call(woken, { action: "propose", name: "conf", replace: true, definition: half })).toMatchObject({ ok: true, body: { version: 2 } })
    // And a hold of seconds is a card whatever it holds: every entry would be a buy and a sell.
    w.book.setSellsNow(() => 0)
    expect(await w.tool.call(woken, { action: "propose", name: "conf", replace: true, definition: def({ exit: { take_profit_pct: 100, stop_loss_pct: 40, max_hold_hours: 0.0003 } }) })).toMatchObject({ ok: false, code: "WOKEN_TURN" })
  })

  test("a slippage bound under the route's default is a card, never at once; one tightened to the default takes at once", async () => {
    const w = await world()
    await w.tool.call(agentA, { action: "propose", name: "conf", definition: def(), wallet: "embedded", mode: "paper", maxSlippageBps: 500 })
    const first = w.proposed.at(-1)!.card
    await runBotCard(w.book, { params: first.params as unknown as Record<string, unknown>, cardId: "card_x", opId: "op_1" })
    expect(await w.tool.call(woken, { action: "propose", name: "conf", replace: true, maxSlippageBps: 100 })).toMatchObject({ ok: true, body: { version: 2 } })
    expect(await w.tool.call(woken, { action: "propose", name: "conf", replace: true, maxSlippageBps: 50 })).toMatchObject({ ok: false, code: "WOKEN_TURN" })
    expect(await w.tool.call(agentA, { action: "propose", name: "conf", replace: true, maxSlippageBps: 50 })).toEqual({ card: "op_2" })
    expect(w.proposed.at(-1)!.card.slippage).toEqual({ words: "its own slippage bound: 0.5%, under the route's 1%: its sells may not fill", looser: true })
    expect(w.book.entry("conf")!.maxSlippageBps).toBe(100)
    // Under the floor nothing is proposed: almost nothing fills there.
    expect(await w.tool.call(agentA, { action: "propose", name: "conf", replace: true, maxSlippageBps: 0 })).toMatchObject({ ok: false, code: "INVALID_SLIPPAGE" })
    expect(await w.tool.call(agentA, { action: "propose", name: "new", definition: def(), wallet: "embedded", mode: "paper", maxSlippageBps: 5 })).toMatchObject({ ok: false, code: "INVALID_SLIPPAGE" })
  })

  test("Free proposes and pauses nothing, and its read says why", async () => {
    const w = await world({ plan: "free" })
    expect(await w.tool.call(agentA, { action: "propose", name: "conf", definition: def(), wallet: "embedded", mode: "paper" })).toMatchObject({ ok: false, code: "BOTS_NEED_PLAN", message: "Bots need a Pro or Max plan. This account is on Free. Nothing changed." })
    expect(await w.tool.call(agentA, { action: "pause", all: true })).toMatchObject({ ok: false, code: "BOTS_NEED_PLAN" })
    expect(await w.tool.call(agentA, { action: "read" })).toMatchObject({ ok: true, body: { gate: expect.stringContaining("Bots need a Pro or Max plan") } })
  })
})

describe("where a bot can start", () => {
  test("from a tape trigger: its pattern and filters as the entry, the definition's exit and sizing; a level trigger can't", async () => {
    const w = await world()
    for (const line of [`when confluence mcap < 500k age < 60m notify as "conf-alert"`, `when ${JUP} < $0.40 notify as "jup-low"`]) {
      const c = w.triggers.check(line, "agent-a")
      await w.triggers.save(line, "agent-a", { expansion: c.trigger.expansion })
    }
    await w.tool.call(agentA, { action: "propose", name: "conf", from_trigger: "conf-alert", definition: { exit: DEFINITION.exit, sizing: DEFINITION.sizing }, wallet: "embedded", mode: "paper" })
    const card = w.proposed[0]!.card
    expect(card.spec.from).toBe('From the trigger "conf-alert", which stays as it is until it\'s switched off.')
    expect(JSON.parse(card.spec.definition)).toMatchObject({ chain: "any", entry: { source: "pattern", pattern: "confluence", filters: { max_mcap_usd: 500_000, max_age_minutes: 60 } } })
    expect(await w.tool.call(agentA, { action: "propose", name: "jup", from_trigger: "jup-low", definition: { exit: DEFINITION.exit, sizing: DEFINITION.sizing }, wallet: "embedded", mode: "paper" })).toMatchObject({ ok: false, code: "NOT_A_TAPE_TRIGGER" })
    expect(await w.tool.call(agentA, { action: "propose", name: "x", from_trigger: "nope", wallet: "embedded", mode: "paper" })).toMatchObject({ ok: false, code: "UNKNOWN_TRIGGER" })
  })

  test("from a saved Hacc strategy: its whole definition, with Hacc's own backtest where it ran one; one Hacc refuses says so", async () => {
    const w = await world()
    await w.tool.call(agentA, { action: "propose", name: "saved", strategy: 173, wallet: "embedded", mode: "paper" })
    expect(w.proposed[0]!.card.spec).toMatchObject({ from: 'Runs Hacc\'s saved strategy "fake-name-6" (id 173, version 1).', words: expect.stringContaining("Buys $25 when several tracked wallets") })
    expect(await w.tool.call(agentA, { action: "propose", name: "gone", strategy: 9, wallet: "embedded", mode: "paper" })).toMatchObject({ ok: false, code: "HACC_NOT_FOUND", message: "Hacc refused: not found. Nothing was proposed." })
    const run = { strategy: { id: 5, name: "s", version: 2, definition: DEFINITION, runs: [{ mode: "backtest", status: "completed", trade_count: 9, pnl_usd: "-1.5", max_drawdown_pct: "20", ended_at: "2026-11-01T00:00:00Z" }] } }
    expect(strategyFrom(run, 5)).toMatchObject({ ok: true, version: 2, backtest: { what: "Hacc's backtest of strategy 5", trades: 9, pnlUsd: -1.5, drawdownPct: 20 } })
  })

  test("a trigger on a bot names one that's saved", async () => {
    const w = await world()
    expect(() => w.triggers.check('on bot "conf" exited notify', "agent-a")).toThrow(/No bot is named "conf", and none is saved/)
    await made(w)
    expect(w.triggers.check('on bot "conf" exited notify', "agent-a").trigger.words).toContain('the bot "conf" sells out of a position')
    // A rules bot never says a word: a trigger waiting on one would never fire.
    expect(() => w.triggers.check('on bot "conf" says "look" notify', "agent-a")).toThrow('"conf" is a rules bot, which never says a word')
  })
})

describe("a bot's recent rows", () => {
  test("in the Journal's words, its fills said, its skips over the day tallied by why", () => {
    const row = (seq: number, at: string, r: Record<string, unknown>) => ({ seq, at, mode: "live", ...r }) as JournalRow
    const rows = [
      row(1, "2026-11-04T09:00:00.000Z", { type: "bot.skipped", name: "conf", reason: "max_concurrent", count: 40 }),
      row(2, "2026-11-06T09:00:00.000Z", { type: "bot.skipped", name: "conf", reason: "max_concurrent", count: 3 }),
      row(3, "2026-11-06T09:01:00.000Z", { type: "bot.skipped", name: "conf", reason: "unpriceable", count: 5 }),
      row(4, "2026-11-06T09:02:00.000Z", { type: "bot.entering", name: "conf", agent: "agent-a", words: "buys $2 of JUP on a confluence signal" }),
      row(5, "2026-11-06T09:02:05.000Z", { type: "operation.succeeded", bot: "conf", botAct: "entry", agent: "agent-a", fill: { mint: JUP } }),
      row(6, "2026-11-06T09:03:00.000Z", { type: "bot.entering", name: "other", agent: "agent-a", words: "buys" }),
    ]
    expect(botRecent(rows, "conf", T0, (m) => (m === JUP ? "JUP" : undefined))).toEqual({
      events: ['09:02 UTC the bot "conf" buys $2 of JUP on a confluence signal', "09:02 UTC its buy of JUP filled"],
      skips: "Skipped 8 signals in the last day: 5 no price on Candle, 3 no free slot.",
    })
  })
})

test("a day's skips by why: a signal heard too late is said so", () => {
  const at = new Date(Date.parse("2026-11-08T05:00:00Z")).toISOString()
  const rows = [{ type: "bot.skipped", seq: 1, at, account: "a", mode: "live", name: "conf", reason: "stale_signal", count: 3 }] as never
  expect(botSkips(rows, "conf", Date.parse("2026-11-08T05:10:00Z"))).toEqual({ total: 3, by: [{ why: "heard too late", count: 3 }] })
})
