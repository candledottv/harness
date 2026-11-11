// Triggers' watchers, on a clock: levels on Candle's market read (once, or again when crossed back, from the
// entry, sells' tokens first, another reader's read shared), the tape (nothing from before the trigger was on,
// nothing heard late, once per token per cooldown, filters checked by the core), personal signals by rule and
// Hacc's asset read, P&L, fills, cards and replays, schedules and sleep, and nothing fired twice across a restart.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Redactor } from "../shared/redact"
import { ASK } from "./autonomy"
import type { ToolOutcome } from "./candle-mcp"
import type { HaccAnswer } from "./hacc"
import { Journal, type JournalRow } from "./journal"
import { KeyBudget } from "./key-budget"
import type { WalletsTopic } from "./agent-wallets"
import { AliasFile, LineReader } from "./line-reader"
import type { SignalRow } from "./signal-stream"
import { TokenNames } from "./token-names"
import { enableTestChain, TEST_CHAIN } from "../shared/chains"
import { HEARTBEAT_MS, LEVEL_READS_PER_BEAT, levelChain, nextOnDays, TAPE_FRESH_MS, TriggerWatch } from "./trigger-watch"
import { type FireCause, TriggerBook, type TriggerBookDeps } from "./triggers"
import { TriggersFileStore } from "./triggers-file"

const JUP = "JupFake111111111111111111111111111111111111"
const BONK = "BonkFake11111111111111111111111111111111111"
const EMBEDDED = "EmbedFake11111111111111111111111111111111111"
const OTHER_WALLET = "TeeFake111111111111111111111111111111111111"
/** A Tuesday, 08:59 local. */
const T0 = new Date(2026, 10, 3, 8, 59, 0).getTime()

const dirs: string[] = []
const journals: Journal[] = []
afterEach(async () => {
  for (const j of journals.splice(0)) await j.close().catch(() => {})
})
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

interface Rig {
  dir: string
  clock: { now: number }
  journal: Journal
  book: TriggerBook
  watch: TriggerWatch
  prices: Map<string, { priceUsd?: number | null; marketCap?: number | null }>
  marketCalls: string[]
  /** Each market read as chain:mint. */
  marketOn: string[]
  hacc: { calls: { route: string; query: Record<string, unknown> }[]; answer: (route: string, query: Record<string, unknown>) => HaccAnswer }
  positions: { mint: string; wallet: string; quantity: number; costBasisUsd: number }[]
  pnl: { usd: number | null; reads: number; byWindow: Record<string, number | null>; asked: (string | undefined)[] }
  /** What the line reader reads against: the wallets read from Candle (none until set), and the P&L window showing. */
  reader: { wallets: WalletsTopic | undefined; window: string | undefined }
  fired: { name: string; cause: FireCause; journalled: boolean }[]
  needs: number
  save(line: string, agent?: string): Promise<string>
  restart(): Promise<void>
}

const ok = (body: unknown): HaccAnswer => ({ kind: "ok", status: 200, body, ms: 1, cached: false })

async function rig(o: { firer?: boolean; dir?: string } = {}): Promise<Rig> {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "chrn-twatch-"))
  if (!o.dir) dirs.push(dir)
  writeFileSync(join(dir, "config.toml"), "")
  const r = {
    dir,
    clock: { now: T0 },
    prices: new Map(),
    marketCalls: [],
    marketOn: [],
    hacc: { calls: [], answer: () => ok({ signals: [] }) },
    positions: [],
    pnl: { usd: null, reads: 0, byWindow: {}, asked: [] },
    reader: { wallets: undefined, window: undefined },
    fired: [],
    needs: 0,
  } as unknown as Rig
  const names = new TokenNames()
  names.learn("JUP", JUP)
  names.learn("BONK", BONK)
  const build = async () => {
    r.journal = await Journal.open({ path: join(dir, "journal.jsonl"), redactor: new Redactor(), account: "acct_fake", now: () => r.clock.now })
    journals.push(r.journal)
    const lines = new LineReader({ aliases: new AliasFile(join(dir, "config.toml")), names, agents: () => ["agent-a", "agent-b"], wallets: () => r.reader.wallets, mode: () => "live" })
    const deps: TriggerBookDeps = {
      file: new TriggersFileStore(join(dir, "triggers.toml")),
      statePath: join(dir, "triggers.json"),
      journal: r.journal,
      lines,
      agents: () => ["agent-a", "agent-b"],
      plan: () => "pro",
      mode: () => "live",
      pnlWindow: () => r.reader.window as string,
      now: () => r.clock.now,
      payWallet: () => ({ address: EMBEDDED, name: "embedded", setting: ASK }),
      feeBps: () => 25,
      onChange: () => r.watch?.refresh(),
    }
    r.book = new TriggerBook(deps)
    if (o.firer !== false)
      r.book.setFirer(async (t, cause) => {
        r.fired.push({ name: t.name, cause, journalled: r.journal.rows().some((row) => row.type === "trigger.fired" && row.name === t.name && JSON.stringify(row.cause) === JSON.stringify(cause)) })
      })
    r.watch = new TriggerWatch({
      book: r.book,
      clock: { now: () => r.clock.now, schedule: () => () => {} },
      market: async (chain, mint) => {
        r.marketCalls.push(mint)
        r.marketOn.push(`${chain}:${mint}`)
        const p = r.prices.get(mint)
        if (!p) return { kind: "error", code: "MARKET_NOT_FOUND", retryable: false, body: {} } satisfies ToolOutcome
        return { kind: "ok", result: { success: true, market: { mint, priceUsd: p.priceUsd ?? null, marketCap: p.marketCap ?? null } } }
      },
      positions: () => r.positions,
      walletOf: () => EMBEDDED,
      pnlUsd: (window) => {
        r.pnl.asked.push(window)
        return window !== undefined && window in r.pnl.byWindow ? r.pnl.byWindow[window]! : r.pnl.usd
      },
      pnlNow: () => {
        r.pnl.reads++
      },
      hacc: async (_agent, route, query) => {
        r.hacc.calls.push({ route, query })
        return r.hacc.answer(route, query)
      },
      nameOf: (mint) => (mint === JUP ? "JUP" : mint === BONK ? "BONK" : undefined),
      needsChanged: () => {
        r.needs++
      },
      onChange: () => {},
    })
    r.book.setWatchInfo((name) => r.watch.info(name))
    r.watch.refresh()
  }
  await build()
  r.save = async (line, agent = "agent-a") => {
    const c = r.book.check(line, agent)
    await r.book.save(line, agent, { expansion: c.trigger.expansion })
    return c.trigger.name
  }
  r.restart = async () => {
    await r.journal.close()
    r.watch.stop()
    await build()
  }
  return r
}

const firedRows = (r: Rig) => r.journal.rows().filter((row) => row.type === "trigger.fired")
const missedRows = (r: Rig) => r.journal.rows().filter((row) => row.type === "trigger.missed")
/** Moves the clock on and runs a heartbeat. */
async function beatAt(r: Rig, ms: number) {
  r.clock.now += ms
  await r.watch.beat()
}

let signalId = 5_000
function signal(r: Rig, patch: Partial<SignalRow> & Record<string, unknown> = {}): SignalRow {
  return { id: ++signalId, pattern: "confluence", asset_address: BONK, asset_chain: "solana", wallet_groups: ["smart_money"], created_at: new Date(r.clock.now - 500).toISOString(), ...patch } as SignalRow
}

describe("levels", () => {
  test("a level on a Hood token keeps its chain: stored with the trigger, read on Hood, and said by its firing", async () => {
    const HOOD = "0x00000000000000000000000000000000000b0b41"
    const r = await rig()
    const name = await r.save(`when ${HOOD} < $0.002 notify`)
    expect(r.book.entries()[0]).toMatchObject({ name, chain: "hood" })
    expect(readFileSync(join(r.dir, "triggers.toml"), "utf8")).toContain('chain = "hood"')
    r.prices.set(HOOD, { priceUsd: 0.0015 })
    await beatAt(r, HEARTBEAT_MS)
    expect(r.marketOn).toEqual([`hood:${HOOD}`])
    expect(firedRows(r)[0]).toMatchObject({ name, cause: { by: "level", what: "price", mint: HOOD, chain: "hood" } })
    // A Solana token's keeps none in the file, as before.
    await r.save("when JUP < $0.40 notify")
    expect(r.book.entries().find((t) => t.line.includes("JUP"))!.chain).toBeUndefined()
  })

  test("a level is read on its stored chain, never one guessed again from its address", () => {
    const off = enableTestChain()
    try {
      const TOKEN = "0x00000000000000000000000000000000000b0b42"
      expect(levelChain({ chain: TEST_CHAIN }, TOKEN)).toBe(TEST_CHAIN)
      expect(levelChain({}, TOKEN)).toBe("hood")
      expect(levelChain({}, JUP)).toBe("solana")
    } finally {
      off()
    }
  })

  test("a stop fires once on a reading under it, journalled before its command is proposed, and switches off", async () => {
    const r = await rig()
    const name = await r.save("when JUP < $0.40 sell 50% of JUP")
    r.prices.set(JUP, { priceUsd: 0.45 })
    await beatAt(r, HEARTBEAT_MS)
    expect(r.fired).toEqual([])
    r.prices.set(JUP, { priceUsd: 0.3981 })
    await beatAt(r, HEARTBEAT_MS)
    expect(r.fired.map((f) => [f.name, f.journalled])).toEqual([[name, true]])
    expect(firedRows(r)[0]).toMatchObject({ name, class: "level", switchedOff: true, cause: { by: "level", what: "price", mint: JUP, reading: 0.3981, level: 0.4 }, words: "JUP was $0.3981, under $0.40" })
    expect(r.book.entries()[0]!.on).toBe(false)
    expect(r.book.live()).toEqual([])
    await beatAt(r, HEARTBEAT_MS)
    expect(r.fired).toHaveLength(1)
  })

  test("an answer with no price is no reading, never a price of zero", async () => {
    const r = await rig()
    await r.save("when JUP < $0.40 sell 50% of JUP")
    r.prices.set(JUP, { priceUsd: null })
    await beatAt(r, HEARTBEAT_MS)
    r.prices.set(JUP, { priceUsd: 0 })
    await beatAt(r, HEARTBEAT_MS)
    expect(r.fired).toEqual([])
    expect(r.book.view().triggers[0]!.watching).toContain("no price from Candle")
  })

  test("again: disarmed once it fires, re-armed when crossed back, and fired again only after its cooldown", async () => {
    const r = await rig()
    await r.save("when JUP < $0.40 sell 25% of JUP again cooldown 10m")
    r.prices.set(JUP, { priceUsd: 0.39 })
    await beatAt(r, HEARTBEAT_MS)
    expect(r.fired).toHaveLength(1)
    expect(r.book.entries()[0]!.on).toBe(true)
    // Still under: disarmed, so nothing more.
    await beatAt(r, HEARTBEAT_MS)
    expect(r.fired).toHaveLength(1)
    // Crossed back: re-armed. Under again within the cooldown: it waits for the cooldown.
    r.prices.set(JUP, { priceUsd: 0.41 })
    await beatAt(r, HEARTBEAT_MS)
    expect(r.book.stateOf(r.book.entries()[0]!.name)?.armed).toBe(true)
    r.prices.set(JUP, { priceUsd: 0.38 })
    await beatAt(r, HEARTBEAT_MS)
    expect(r.fired).toHaveLength(1)
    await beatAt(r, 10 * 60_000)
    expect(r.fired).toHaveLength(2)
  })

  test("a market cap from Candle's read; none known never passes", async () => {
    const r = await rig()
    await r.save("when JUP mcap < 500k notify")
    r.prices.set(JUP, { priceUsd: 0.4, marketCap: null })
    await beatAt(r, HEARTBEAT_MS)
    expect(r.fired).toEqual([])
    r.prices.set(JUP, { priceUsd: 0.4, marketCap: 480_000 })
    await beatAt(r, HEARTBEAT_MS)
    expect(firedRows(r)[0]).toMatchObject({ cause: { what: "mcap", reading: 480_000, level: 500_000 }, words: "JUP's market cap was $480K, under $500K" })
  })

  test("from the entry: Candle's cost book on the trigger's wallet, across agents; no position, no level, and it says so", async () => {
    const r = await rig()
    await r.save("when JUP down 20% sell 100% of JUP")
    r.prices.set(JUP, { priceUsd: 0.4 })
    await beatAt(r, HEARTBEAT_MS)
    // Nothing held: nothing read for it, and the topic says why.
    expect(r.marketCalls).toEqual([])
    expect(r.book.view().triggers[0]!.watching).toBe("No position in JUP on its wallet yet, so it waits for one.")
    // $0.50 a token over two agents' books on the wallet; another wallet's position doesn't count.
    r.positions.push({ mint: JUP, wallet: EMBEDDED, quantity: 10, costBasisUsd: 4 }, { mint: JUP, wallet: EMBEDDED, quantity: 10, costBasisUsd: 6 }, { mint: JUP, wallet: OTHER_WALLET, quantity: 100, costBasisUsd: 1 })
    await beatAt(r, HEARTBEAT_MS)
    expect(r.fired).toEqual([])
    expect(r.book.view().triggers[0]!.watching).toContain("down 20% from $0.5 is $0.4")
    r.prices.set(JUP, { priceUsd: 0.399 })
    await beatAt(r, HEARTBEAT_MS)
    expect(firedRows(r)[0]).toMatchObject({ cause: { what: "entry", entryUsd: 0.5, level: 0.4, reading: 0.399 } })
  })

  test("a read another reader just made (the token pane's) is used as it is; each level says its measured pace", async () => {
    const r = await rig()
    await r.save("when JUP < $0.40 sell 50% of JUP")
    r.prices.set(JUP, { priceUsd: 0.45 })
    for (let i = 0; i < 4; i++) await beatAt(r, HEARTBEAT_MS)
    expect(r.marketCalls).toHaveLength(4)
    expect(r.book.view().triggers[0]).toMatchObject({ paceMs: HEARTBEAT_MS, watching: "checked about every 5 s · JUP $0.45" })
    r.clock.now += 1_000
    r.watch.noteMarket({ kind: "ok", result: { market: { mint: JUP, priceUsd: 0.39 } } })
    await beatAt(r, HEARTBEAT_MS - 2_000)
    expect(r.marketCalls).toHaveLength(4)
    expect(r.fired).toHaveLength(1)
  })

  test("at most 20 tokens a heartbeat, sells' first; past that each is read less often, and none counts toward a key's limit", async () => {
    const r = await rig()
    const mints = Array.from("abcdefghijkmnopqrstuvwxyz", (c) => `Tok${c}Fake${"1".repeat(35)}`)
    for (const [i, mint] of mints.entries()) {
      r.prices.set(mint, { priceUsd: 2 })
      await r.save(i < 5 ? `when ${mint} < $1 sell 100% of ${mint}` : `when ${mint} > $5 notify`)
    }
    const budget = new KeyBudget({ limitOf: () => 300, agents: () => ["agent-a"], preferred: () => "agent-a", now: () => r.clock.now })
    await beatAt(r, HEARTBEAT_MS)
    expect(r.marketCalls).toHaveLength(LEVEL_READS_PER_BEAT)
    expect(r.marketCalls.slice(0, 5).sort()).toEqual(mints.slice(0, 5).sort())
    // Two minutes: the sells' tokens every heartbeat, the rest taking turns, about every 7 s.
    for (let i = 0; i < 24; i++) await beatAt(r, HEARTBEAT_MS)
    const count = (mint: string) => r.marketCalls.filter((m) => m === mint).length
    for (const mint of mints.slice(0, 5)) expect(count(mint)).toBe(25)
    for (const mint of mints.slice(5)) expect([18, 19]).toContain(count(mint))
    expect(r.marketCalls).toHaveLength(25 * LEVEL_READS_PER_BEAT)
    // The levels' reads go uncounted (the core sends them so), so the key's budget is untouched for trades and panes.
    expect(budget.use()[0]).toMatchObject({ used: 0, background: 0 })
    expect(budget.uncountedKey()).toBe("agent-a")
  })

  test("Pro's budget with twenty market-cap levels: with a view open the token pane's reads are shared; open or closed, the key's limit is untouched by them", async () => {
    const r = await rig()
    const mints = Array.from("abcdefghijkmnopqrstu", (c) => `Mcap${c}Fake${"1".repeat(34)}`)
    for (const [i, mint] of mints.entries()) {
      r.prices.set(mint, { priceUsd: 1, marketCap: 900_000 })
      await r.save(`when ${mint} mcap < 500k notify as "level ${i}"`)
    }
    const budget = new KeyBudget({ limitOf: () => 300, agents: () => ["agent-a"], preferred: () => "agent-a", now: () => r.clock.now })
    budget.want("linked", { perMin: () => 12, naturalMs: 5_000 })
    // A view open: the token pane samples the first token every 5 s, through the budget, and the watcher hears it.
    const linked = () => {
      const agent = budget.take("linked")
      if (!agent) return
      budget.noteCall(agent)
      r.watch.noteMarket({ kind: "ok", result: { market: { mint: mints[0], priceUsd: 1, marketCap: 900_000 } } })
    }
    for (let i = 0; i < 12; i++) {
      r.clock.now += HEARTBEAT_MS
      linked()
      await r.watch.beat()
    }
    expect(r.marketCalls.filter((m) => m === mints[0])).toHaveLength(0)
    expect(r.marketCalls).toHaveLength(12 * 19)
    expect(budget.use()[0]).toMatchObject({ used: 12, background: 12 })
    // Room for a card's calls all the while.
    expect(budget.take("prices", "agent-a", 3)).toBe("agent-a")
    // The view closed: the watcher reads all twenty itself, and the key's minute empties.
    r.marketCalls.length = 0
    for (let i = 0; i < 12; i++) await beatAt(r, HEARTBEAT_MS)
    expect(r.marketCalls).toHaveLength(12 * 20)
    expect(budget.use()[0]).toMatchObject({ used: 0, background: 0 })
    expect(r.fired).toEqual([])
  })

  test("P&L: the window's figure after a read", async () => {
    const r = await rig()
    await r.save("when pnl < -$20 notify")
    r.pnl.usd = -5
    r.watch.pnlRead()
    r.pnl.usd = -21.4
    r.watch.pnlRead()
    await Bun.sleep(5)
    expect(firedRows(r)[0]).toMatchObject({ cause: { by: "level", what: "pnl", reading: -21.4, level: -20 }, words: "the P&L window's figure was -$21.40, under -$20" })
  })
})

describe("a P&L level's own window", () => {
  test("it reads its own window's figure, whatever the P&L tab shows: changing the window fires nothing", async () => {
    const r = await rig()
    r.reader.window = "midnight"
    await r.save("when pnl < -$20 notify")
    // Today is fine; the last 24 hours, which the tab is switched to, are well under the level.
    r.pnl.byWindow = { midnight: -5, "24h": -80 }
    r.pnl.usd = -80
    r.reader.window = "24h"
    r.watch.pnlRead()
    await Bun.sleep(5)
    expect(firedRows(r)).toEqual([])
    expect(r.pnl.asked.at(-1)).toBe("midnight")
    r.pnl.byWindow.midnight = -21.4
    r.watch.pnlRead()
    await Bun.sleep(5)
    expect(firedRows(r)[0]).toMatchObject({ cause: { by: "level", what: "pnl", reading: -21.4, level: -20 }, words: "your P&L since midnight was -$21.40, under -$20" })
  })

  test("one saved before its line kept a window follows the one showing, and its row says changing it can fire it", async () => {
    const r = await rig()
    const name = await r.save("when pnl < -$20 notify")
    r.pnl.usd = -5
    r.watch.pnlRead()
    expect(r.pnl.asked.at(-1)).toBeUndefined()
    expect(r.watch.info(name)?.watching).toContain("it follows the P&L window showing, so changing the window can fire it")
  })
})

describe("a line that reads again", () => {
  const TEE = "TeeFakeA11111111111111111111111111111111111"
  const tee = { id: "teeA", address: TEE, label: "tee-stop", chain: "solana", active: true }
  const READ = { agents: { "agent-a": { payable: { embedded: { address: EMBEDDED, chain: "solana" }, tee: [tee], readAt: 0, unreadable: [] }, embeddedWallet: "allowed", prefix: "momeAb3d" } }, account: [tee], boundTo: { [TEE]: "agent-a" } } as unknown as WalletsTopic

  test("a stop that pays from a named wallet, first read before Candle's wallets were, fires once they are", async () => {
    const r = await rig()
    r.reader.wallets = READ
    await r.save("when JUP < $0.40 sell 100% of JUP from tee-stop")
    // A fresh core: a view and a heartbeat come before the wallets' first read.
    r.reader.wallets = undefined
    await r.restart()
    r.book.view()
    r.prices.set(JUP, { priceUsd: 0.39 })
    await beatAt(r, 5_000)
    expect(r.fired).toEqual([])
    r.reader.wallets = READ
    await beatAt(r, 5_000)
    await Bun.sleep(5)
    expect(r.fired.map((f) => f.name)).toEqual(["JUP < $0.40"])
  })
})

describe("Hacc's tape", () => {
  test("nothing from before the trigger was switched on; once per token per cooldown; each other token fires", async () => {
    const r = await rig()
    const old = signal(r, { created_at: new Date(T0 - 60_000).toISOString() })
    await r.save("when confluence notify")
    r.clock.now += 1_000
    await r.watch.onTape([old, signal(r, { pattern: "large_move" })])
    expect(r.fired).toEqual([])
    const first = signal(r)
    await r.watch.onTape([first, signal(r)])
    expect(r.fired.map((f) => f.cause)).toEqual([{ by: "tape", mint: BONK, chain: "solana", signalId: first.id, pattern: "confluence", signalAt: first.created_at }])
    r.clock.now += 20 * 60_000
    await r.watch.onTape([signal(r), signal(r, { asset_address: JUP })])
    expect(r.fired.map((f) => (f.cause as { mint: string }).mint)).toEqual([BONK, JUP])
    r.clock.now += 11 * 60_000
    await r.watch.onTape([signal(r)])
    expect(r.fired).toHaveLength(3)
  })

  test("the cooldown goes by when a row happened: one from inside it, heard once it's over (a read-back after a restart), never fires", async () => {
    const r = await rig()
    await r.save("when confluence notify cooldown 2m")
    r.clock.now += 1_000
    const first = signal(r)
    await r.watch.onTape([first])
    expect(r.fired).toHaveLength(1)
    r.clock.now += 30_000
    const inside = signal(r)
    r.clock.now += 3 * 60_000
    await r.watch.onTape([first, inside])
    expect(r.fired).toHaveLength(1)
    await r.watch.onTape([signal(r)])
    expect(r.fired).toHaveLength(2)
  })

  test("a row heard over 10 minutes after it happened is said as missed, never acted on", async () => {
    const r = await rig()
    await r.save("when confluence notify")
    r.clock.now += TAPE_FRESH_MS + 60_000
    await r.watch.onTape([signal(r, { created_at: new Date(T0 + 500).toISOString() })])
    expect(r.fired).toEqual([])
    expect(missedRows(r)[0]).toMatchObject({ class: "tape", signals: 1 })
  })

  test("a tape trigger on Hood: its market-cap filter reads the row's token on the row's own chain, and its firing says the chain", async () => {
    const HOOD = "0x00000000000000000000000000000000000b0b44"
    const r = await rig()
    await r.save("when confluence mcap < 500k chain hood notify")
    r.clock.now += 1_000
    r.prices.set(HOOD, { priceUsd: 0.002, marketCap: 300_000 })
    await r.watch.onTape([signal(r, { asset_address: HOOD, asset_chain: "hood" }), signal(r)])
    expect(r.marketOn).toEqual([`hood:${HOOD}`])
    expect(r.fired.map((f) => f.cause)).toEqual([expect.objectContaining({ by: "tape", mint: HOOD, chain: "hood" })])
  })

  test("a notify trigger on a Hood token Candle doesn't list takes Hacc's market cap for its filter, and its firing says so", async () => {
    const HOOD = "0x00000000000000000000000000000000000b0b46"
    const r = await rig()
    const name = await r.save("when new_ticker mcap < 500k chain hood notify")
    r.clock.now += 1_000
    r.hacc.answer = (route) => (route === `/v1/market/token/${HOOD}` ? ok({ chain: "hood", market: { address: HOOD, market_cap: 120_000 } }) : ok({ signals: [] }))
    const row = signal(r, { pattern: "new_ticker", asset_address: HOOD, asset_chain: "hood" })
    await r.watch.onTape([row])
    expect(r.marketOn).toEqual([`hood:${HOOD}`])
    expect(r.hacc.calls).toEqual([{ route: `/v1/market/token/${HOOD}`, query: { chain: "hood" } }])
    expect(r.fired.map((f) => f.cause)).toEqual([{ by: "tape", mint: HOOD, chain: "hood", signalId: row.id, pattern: "new_ticker", signalAt: row.created_at, marketCap: { usd: 120_000, from: "hacc" } }])
    expect(firedRows(r)[0]).toMatchObject({ name })
    expect(String(firedRows(r)[0]!.words)).toContain("market cap $120K from Hacc: Candle doesn't list it")
    // Over the filter on Hacc's figure: not fired, and nothing skipped, as any token over it.
    r.hacc.answer = (route) => (route.startsWith("/v1/market/token/") ? ok({ market: { address: "0x00000000000000000000000000000000000b0b47", market_cap: 900_000 } }) : ok({ signals: [] }))
    await r.watch.onTape([signal(r, { pattern: "new_ticker", asset_address: "0x00000000000000000000000000000000000b0b47", asset_chain: "hood" })])
    await r.watch.flushSkips()
    expect(r.fired).toHaveLength(1)
    expect(r.journal.rows().filter((x) => x.type === "trigger.skipped")).toEqual([])
  })

  test("a trigger that trades keeps to Candle's market cap: a token Candle doesn't list is skipped with why, and Hacc isn't asked", async () => {
    const r = await rig()
    const name = await r.save("when new_ticker mcap < 500k buy $2 of it")
    r.clock.now += 1_000
    const row = signal(r, { pattern: "new_ticker" })
    await r.watch.onTape([row])
    expect(r.fired).toEqual([])
    expect(r.hacc.calls.filter((c) => c.route.startsWith("/v1/market/token/"))).toEqual([])
    await r.watch.flushSkips()
    const skipped = r.journal.rows().filter((x) => x.type === "trigger.skipped")
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatchObject({ name, agent: "agent-a", reason: "not_on_candle", count: 1, signals: [row.id], mints: [BONK] })
    expect(String(skipped[0]!.words)).toBe("Candle doesn't list BONK, and a trigger that trades goes by Candle's market cap only, so its market-cap filter can't pass")
  })

  test("skips are gathered per reason with a count, and the trigger's watch words say the day's tally, across a restart too", async () => {
    const r = await rig()
    const name = await r.save("when new_ticker mcap < 500k notify")
    r.clock.now += 1_000
    // BONK isn't on Candle; JUP is, with no market cap; Hacc gives neither one.
    r.prices.set(JUP, { priceUsd: 0.4, marketCap: null })
    await r.watch.onTape([signal(r, { pattern: "new_ticker" })])
    r.clock.now += 20 * 60_000
    await r.watch.onTape([signal(r, { pattern: "new_ticker" }), signal(r, { pattern: "new_ticker", asset_address: JUP })])
    expect(r.fired).toEqual([])
    await r.watch.flushSkips()
    const skipped = r.journal.rows().filter((x) => x.type === "trigger.skipped")
    expect(skipped.map((x) => [x.reason, x.count])).toEqual([
      ["not_on_candle", 2],
      ["no_market_cap", 1],
    ])
    expect(String(skipped[0]!.words)).toBe("2 signals, the last because Candle doesn't list BONK and Hacc gave none for it, so its market-cap filter can't pass")
    expect(String(skipped[1]!.words)).toBe("Candle doesn't know JUP's market cap and Hacc gave none for it, so its market-cap filter can't pass")
    const watching = () => r.book.view().triggers.find((t) => t.name === name)!.watching
    expect(watching()).toBe("watches Hacc's tape for new_ticker · skipped 3 in the last day: 2 not on Candle, 1 no market cap")
    await r.restart()
    expect(watching()).toBe("watches Hacc's tape for new_ticker · skipped 3 in the last day: 2 not on Candle, 1 no market cap")
    // Over a day on, the tally's gone.
    r.clock.now += 24 * 60 * 60_000 + 60_000
    expect(watching()).toBe("watches Hacc's tape for new_ticker")
  })

  test("a row whose address doesn't fit the chain Hacc says fires no tape trigger, filtered to that chain or not, and reads nothing", async () => {
    const EVM_TOKEN = "0x00000000000000000000000000000000000b0b45"
    const r = await rig()
    await r.save("when confluence mcap < 500k chain solana notify")
    await r.save("when confluence notify as \"any-chain\"")
    r.clock.now += 1_000
    r.prices.set(EVM_TOKEN, { priceUsd: 0.002, marketCap: 300_000 })
    await r.watch.onTape([signal(r, { asset_address: EVM_TOKEN, asset_chain: "solana" }), signal(r, { asset_chain: "hood" })])
    expect(r.marketOn).toEqual([])
    expect(r.fired).toEqual([])
  })

  test("chain and group from the row; a market cap from Candle, where Hacc's filter would pass an unknown one; age from Hacc's filtered tape", async () => {
    const r = await rig()
    await r.save("when confluence mcap < 500k group smart_money chain solana notify")
    r.clock.now += 1_000
    r.prices.set(BONK, { priceUsd: 0.00002, marketCap: null })
    await r.watch.onTape([signal(r, { asset_chain: "hood" }), signal(r, { wallet_groups: ["kols"] }), signal(r)])
    expect(r.fired).toEqual([])
    expect(r.marketCalls).toEqual([BONK])
    r.prices.set(BONK, { priceUsd: 0.00002, marketCap: 420_000 })
    r.clock.now += 20_000
    await r.watch.onTape([signal(r)])
    expect(r.fired).toHaveLength(1)

    const a = await rig()
    await a.save("when new_ticker age < 60m buy $2 of it")
    a.clock.now += 1_000
    const row = signal(a, { pattern: "new_ticker" })
    a.hacc.answer = () => ok({ signals: [] })
    await a.watch.onTape([row])
    expect(a.fired).toEqual([])
    expect(a.hacc.calls[0]).toMatchObject({ route: "/v1/signals", query: { asset: BONK, pattern: "new_ticker", max_age_minutes: 60, since: new Date(Date.parse(row.created_at) - 1).toISOString() } })
    a.hacc.answer = () => ok({ signals: [{ id: row.id }] })
    await a.watch.onTape([{ ...row, id: row.id + 1 } as SignalRow])
    expect(a.fired).toHaveLength(0)
    const again = signal(a, { pattern: "new_ticker" })
    a.hacc.answer = () => ok({ signals: [{ id: again.id }] })
    await a.watch.onTape([again])
    expect(a.fired.map((f) => f.cause)).toMatchObject([{ by: "tape", mint: BONK, signalId: again.id }])
  })

  test("a tape trigger holds Hacc's stream open, and switched off lets it go", async () => {
    const r = await rig()
    expect(r.watch.needs()).toEqual({ tape: false, mine: false })
    const name = await r.save("when confluence notify")
    expect(r.watch.needs()).toEqual({ tape: true, mine: false })
    await r.save("when mine notify")
    expect(r.watch.needs()).toEqual({ tape: true, mine: true })
    const before = r.needs
    await r.book.set(name, false, { clientId: "v1", main: true })
    expect(r.watch.needs()).toEqual({ tape: false, mine: true })
    expect(r.needs).toBe(before + 1)
  })
})

describe("personal signals", () => {
  test("by the rule's name, read from Hacc; `it` is the token from Hacc's asset read, and one it can't read is said as missed", async () => {
    const r = await rig()
    await r.save('when mine "whales" buy $2 of it')
    r.hacc.answer = (route) =>
      route === "/v1/me/rules"
        ? ok({ rules: [{ id: 7, name: "whales" }, { id: 8, name: "others" }] })
        : route === "/v1/assets/41"
          ? ok({ asset: { id: 41, chain: "solana", address: JUP } })
          : { kind: "refused", code: "HACC_NOT_FOUND", message: "not found", ms: 1 }
    r.clock.now += 1_000
    const at = new Date(r.clock.now - 1_000).toISOString()
    await r.watch.onMine([{ id: 1, rule_id: 8, asset_id: 41, pattern: "confluence", created_at: at } as SignalRow])
    expect(r.fired).toEqual([])
    await r.watch.onMine([{ id: 2, rule_id: 7, asset_id: 41, pattern: "confluence", created_at: at } as SignalRow])
    expect(r.fired.map((f) => f.cause)).toEqual([{ by: "mine", mint: JUP, chain: "solana", assetId: 41, signalId: 2, pattern: "confluence", rule: "whales", signalAt: at }])
    await r.watch.onMine([{ id: 3, rule_id: 7, asset_id: 99, pattern: "confluence", created_at: at } as SignalRow])
    expect(r.fired).toHaveLength(1)
    expect(missedRows(r)[0]!.words).toContain("didn't say which token personal signal 3 was about")
    // The rules are read once in five minutes.
    expect(r.hacc.calls.filter((c) => c.route === "/v1/me/rules")).toHaveLength(1)
  })
})

describe("the person's state", () => {
  const fillRow = (opId: string, trigger?: string) => ({ seq: 1, at: new Date().toISOString(), account: "acct_fake", mode: "live", type: "operation.succeeded", agent: "agent-a", opId, ...(trigger ? { trigger } : {}) }) as JournalRow
  const fillOf = (mints: string[]) => () => ({ agent: "agent-a", mints })

  test("on fill of a token: its fills only, not another's, nor a firing's own; with the cooldown", async () => {
    const r = await rig()
    const name = await r.save("on fill of JUP notify")
    await r.watch.onJournal(fillRow("o1"), fillOf([BONK]))
    await r.watch.onJournal(fillRow("o2"), () => undefined)
    await r.watch.onJournal(fillRow("o3", name), fillOf([JUP]))
    expect(r.fired).toEqual([])
    await r.watch.onJournal(fillRow("o4"), fillOf([JUP]))
    expect(r.fired.map((f) => f.cause)).toEqual([{ by: "event", event: "fill", agent: "agent-a", opId: "o4", mint: JUP }])
    await r.watch.onJournal(fillRow("o5"), fillOf([JUP]))
    expect(r.fired).toHaveLength(1)
  })

  test("a card expiring and a replay ending", async () => {
    const r = await rig()
    await r.save("on card expired notify")
    await r.save("on replay ended wake agent-b")
    await r.watch.onJournal({ seq: 2, at: "", account: "acct_fake", mode: "live", type: "card.expired", agent: "agent-a", cardId: "c9", opId: "o9" } as JournalRow)
    await r.watch.onJournal({ seq: 3, at: "", account: "acct_fake", mode: "live", type: "hacc.replay", agent: "agent-a", jobId: 12, status: "done" } as JournalRow)
    expect(firedRows(r).map((row) => row.words)).toEqual(["a card of agent-a's expired", "a replay (job 12) ended"])
  })
})

describe("schedules and sleep", () => {
  test("every day 09:00: on time once, the next run kept; local time", async () => {
    const r = await rig()
    const name = await r.save("every day 09:00 notify")
    await beatAt(r, HEARTBEAT_MS)
    expect(r.book.stateOf(name)?.nextRun).toBe(new Date(2026, 10, 3, 9, 0).toISOString())
    expect(r.book.view().triggers[0]!.watching).toBe("next run 09:00")
    r.clock.now = new Date(2026, 10, 3, 9, 0, 3).getTime()
    await r.watch.beat()
    await beatAt(r, HEARTBEAT_MS)
    expect(firedRows(r).map((row) => [row.cause, row.words])).toEqual([[{ by: "schedule", due: new Date(2026, 10, 3, 9, 0).toISOString() }, "its 09:00 run"]])
    expect(r.book.stateOf(name)?.nextRun).toBe(new Date(2026, 10, 4, 9, 0).toISOString())
    expect(nextOnDays([1, 2, 3, 4, 5], "09:00", new Date(2026, 10, 7, 10, 0).getTime())).toBe(new Date(2026, 10, 9, 9, 0).getTime())
  })

  test("a sleep: P&L and levels check at once; a run slept through runs once late inside its window, else is said as missed", async () => {
    const r = await rig()
    await r.save("every day 09:00 notify")
    await r.save("every 30m notify")
    await beatAt(r, HEARTBEAT_MS)
    // Asleep from 08:59 to 09:40: the daily run is 40 minutes late, inside its hour; the 30m (due 09:29) 11 minutes, inside its 30.
    r.clock.now = new Date(2026, 10, 3, 9, 40).getTime()
    await r.watch.beat()
    expect(r.pnl.reads).toBe(1)
    const byName = (rows: JournalRow[]) => [...rows].sort((a, b) => String(a.name).localeCompare(String(b.name)))
    expect(byName(firedRows(r)).map((row) => [row.name, (row.cause as { late?: boolean }).late])).toEqual([
      ["every 30m", true],
      ["every day 09:00", true],
    ])
    expect(firedRows(r).find((row) => row.name === "every day 09:00")!.words).toBe("its 09:00 run, 40 minutes late: this machine slept or the core wasn't running")
    // Asleep until the next afternoon: the daily run is said as missed. The 30m runs its latest run once, late, and
    // says the ones before it as missed, in one line.
    r.clock.now = new Date(2026, 10, 4, 14, 0).getTime()
    await r.watch.beat()
    expect(byName(firedRows(r)).map((row) => [row.name, row.words])).toEqual([
      ["every 30m", expect.any(String)],
      ["every 30m", expect.stringMatching(/^its 13:\d\d run, \d+ minutes? late: this machine slept/)],
      ["every day 09:00", expect.any(String)],
    ])
    expect(byName(missedRows(r)).map((row) => [row.name, row.words])).toEqual([
      ["every 30m", "Missed 56 runs from 09:59 on Tuesday: this machine slept or the core wasn't running."],
      ["every day 09:00", "Missed its 09:00 run: this machine slept or the core wasn't running, and a run over 1 hour late doesn't run."],
    ])
    const runs = firedRows(r).length
    await beatAt(r, HEARTBEAT_MS)
    expect(firedRows(r)).toHaveLength(runs)
  })
})

describe("at HH:MM, once", () => {
  test("runs at its next HH:MM, then switches off; missed past its hour, it's said and switched off", async () => {
    const r = await rig()
    const name = await r.save("at 09:00 notify")
    await beatAt(r, HEARTBEAT_MS)
    expect(r.book.stateOf(name)?.nextRun).toBe(new Date(2026, 10, 3, 9, 0).toISOString())
    r.clock.now = new Date(2026, 10, 3, 9, 0, 3).getTime()
    await r.watch.beat()
    expect(firedRows(r).map((row) => [row.name, row.words, row.switchedOff])).toEqual([[name, "its 09:00 run", true]])
    expect(r.book.view().triggers.find((t) => t.name === name)?.on).toBe(false)
    r.clock.now = new Date(2026, 10, 4, 9, 0, 3).getTime()
    await r.watch.beat()
    expect(firedRows(r)).toHaveLength(1)

    const late = await rig()
    const other = await late.save("at 09:00 notify")
    await beatAt(late, HEARTBEAT_MS)
    late.clock.now = new Date(2026, 10, 3, 11, 0).getTime()
    await late.watch.beat()
    expect(firedRows(late)).toHaveLength(0)
    expect(missedRows(late).map((row) => [row.words, row.switchedOff])).toEqual([["Missed its 09:00 run: this machine slept or the core wasn't running, and a run over 1 hour late doesn't run. It was to run once, so it's switched off.", true]])
    expect(late.book.view().triggers.find((t) => t.name === other)?.on).toBe(false)
  })
})

describe("nothing fires twice across a restart", () => {
  test("the tape's cooldown, a level that fired once, and a schedule's next run are kept; with no state file, from the journal", async () => {
    const r = await rig()
    await r.save("when confluence notify")
    await r.save("when JUP < $0.40 sell 50% of JUP")
    await r.save("every day 09:00 notify")
    r.clock.now += 2_000
    const row = signal(r)
    await r.watch.onTape([row])
    r.prices.set(JUP, { priceUsd: 0.39 })
    r.clock.now = new Date(2026, 10, 3, 9, 0, 1).getTime()
    await r.watch.beat()
    expect(r.fired).toHaveLength(3)
    await r.restart()
    r.fired.length = 0
    await r.watch.onTape([row, signal(r)])
    await beatAt(r, HEARTBEAT_MS)
    expect(r.fired).toEqual([])
    // The same from the journal alone.
    rmSync(join(r.dir, "triggers.json"))
    await r.restart()
    await r.watch.onTape([signal(r)])
    await beatAt(r, HEARTBEAT_MS)
    expect(r.fired).toEqual([])
  })

  test("with no firing path wired, nothing fires and nothing is said as missed; levels still read, for their pace", async () => {
    const r = await rig({ firer: false })
    await r.save("when JUP < $0.40 sell 50% of JUP")
    await r.save("every day 09:00 notify")
    await r.save("when confluence notify")
    r.prices.set(JUP, { priceUsd: 0.39 })
    r.clock.now += 3 * 3_600_000
    await r.watch.beat()
    r.clock.now += 1_000
    await r.watch.onTape([signal(r, { created_at: new Date(T0).toISOString() })])
    expect(r.marketCalls).toEqual([JUP])
    expect(r.journal.rows().filter((row) => row.type === "trigger.fired" || row.type === "trigger.missed")).toEqual([])
    expect(r.book.live()).toHaveLength(3)
  })
})
