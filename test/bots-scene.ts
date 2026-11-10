// Rules bots a person has a day in, for the Bots tab's frames: a live bot on a TEE wallet of its own with two
// positions open, one of them past its trailing exit's arming; a paper bot; a bot an agent paused, its one position
// still guarded by its exits; and a stopped one. Each with its book, as the core's `bots` topic sends it.
import type { BotBookView } from "../src/core/bot-books"
import type { BotsTopic, BotView } from "../src/core/bots"
import type { CodeBotView } from "../src/core/code-bots"
import { readDefinition } from "../src/shared/definition"
import { definitionWords } from "../src/shared/definition-words"
import { CLOCK } from "./frame-scenes"

const at = (ms: number) => new Date(CLOCK - ms).toISOString()
const H = 3_600_000
const TEE = "TeeConfFake1111111111111111111111111111111"

function def(json: unknown) {
  const read = readDefinition(json)
  if (!read.ok) throw new Error(read.message)
  return read.definition
}

const CONF = def({ chain: "solana", entry: { source: "pattern", pattern: "confluence", filters: { max_mcap_usd: 500_000, max_age_minutes: 60 } }, exit: { take_profit_pct: 100, stop_loss_pct: 40, max_hold_hours: 24, trailing: { arm_multiple: 1.5, drop_pct: 20 } }, sizing: { usd_per_trade: 2, max_concurrent: 4 } })
const FRESH = def({ chain: "solana", entry: { source: "pattern", pattern: "new_ticker", filters: { max_mcap_usd: 100_000 } }, exit: { take_profit_pct: 50, stop_loss_pct: 25, max_hold_hours: 2 }, sizing: { usd_per_trade: 1, max_concurrent: 2 } })
const WOKE = def({ chain: "solana", entry: { source: "pattern", pattern: "dormancy" }, exit: { take_profit_pct: 80, stop_loss_pct: 30 }, sizing: { usd_per_trade: 1.5, max_concurrent: 1 } })
const TEST1 = def({ chain: "solana", entry: { source: "pattern", pattern: "large_move" }, exit: { stop_loss_pct: 20, max_hold_hours: 1 }, sizing: { usd_per_trade: 1, max_concurrent: 1 } })

const bot = (over: Partial<BotView> & Pick<BotView, "name" | "definition">): BotView => ({ kind: "rules", agent: "agent-a", wallet: "embedded", paysFrom: "embedded", mode: "live", state: "on", entries: true, exits: true, words: definitionWords(over.definition), ...over })

export const BOTS: BotsTopic = {
  problems: [],
  bots: [
    bot({ name: "conf", definition: CONF, wallet: TEE, paysFrom: "bot-conf", onSince: at(62 * H), open: 2 }),
    bot({ name: "fresh", definition: FRESH, agent: "agent-b", mode: "paper", onSince: at(30 * H), open: 1 }),
    bot({ name: "woke", definition: WOKE, state: "paused", entries: false, stateWords: "paused by agent-a at 05:02", open: 1 }),
    bot({ name: "test1", definition: TEST1, state: "stopped", entries: false, exits: false, stateWords: "stopped by you, Jan 13" }),
  ],
  books: {
    conf: {
      open: [
        { id: "op-c2", mint: "BonkxFake11111111111111111111111111111111111", token: "BONKX", since: at(0.42 * H), costUsd: 2, entryUsd: 0.0000412, nowUsd: 0.0000371, peakUsd: 0.0000428, unrealizedUsd: -0.2, stopUsd: 0.00002472, targetUsd: 0.0000824, trail: { armUsd: 0.0000618, dropPct: 20, armed: false }, holdUntil: new Date(CLOCK - 0.42 * H + 24 * H).toISOString() },
        { id: "op-c1", mint: "WifzFake111111111111111111111111111111111111", token: "WIFZ", since: at(2.17 * H), costUsd: 2.01, entryUsd: 0.001204, nowUsd: 0.001595, peakUsd: 0.001806, unrealizedUsd: 0.65, stopUsd: 0.0007224, targetUsd: 0.002408, trail: { armUsd: 0.001806, dropPct: 20, armed: true, sellsUnderUsd: 0.0014448 }, holdUntil: new Date(CLOCK - 2.17 * H + 24 * H).toISOString() },
      ],
      closed: 12,
      realizedUsd: 3.41,
      todayUsd: 1.24,
      unrealizedUsd: 0.45,
      valued: true,
      exitsBy: [{ reason: "take_profit", count: 7 }, { reason: "stop_loss", count: 4 }, { reason: "trailing_stop", count: 1 }],
      skips: { total: 31, by: [{ why: "its market cap", count: 18 }, { why: "no price on Candle", count: 7 }, { why: "no free slot", count: 4 }, { why: "Hacc's filters", count: 2 }] },
      recent: [
        { at: at(0.42 * H), act: "in", token: "BONKX", usd: 2 },
        { at: at(0.95 * H), act: "out", token: "MOONQ", reason: "take_profit", usd: 4.02, realizedUsd: 2.01 },
        { at: at(2.17 * H), act: "in", token: "WIFZ", usd: 2.01 },
      ],
      backtest: { what: "Hacc's replay 4412 of this exact definition", verdict: "pass", trades: 41, pnlUsd: 9.12, drawdownPct: 18.4, from: "2027-01-05T00:00:00Z", to: "2027-01-12T00:00:00Z" },
      lab: true,
    },
    fresh: { open: [{ id: "paper:88", mint: "PepexFake11111111111111111111111111111111111", token: "PEPEX", since: at(0.5 * H), costUsd: 1, entryUsd: 0.00021, nowUsd: 0.000241, peakUsd: 0.000252, unrealizedUsd: 0.15, stopUsd: 0.0001575, targetUsd: 0.000315, holdUntil: new Date(CLOCK + 1.5 * H).toISOString() }], closed: 5, realizedUsd: 0.95, todayUsd: 0.4, unrealizedUsd: 0.15, valued: true, exitsBy: [{ reason: "take_profit", count: 3 }, { reason: "max_hold", count: 2 }], recent: [{ at: at(0.5 * H), act: "in", token: "PEPEX", usd: 1 }], lab: true },
    woke: { open: [{ id: "op-w1", mint: "DogeqFake11111111111111111111111111111111111", token: "DOGEQ", since: at(5 * H), costUsd: 1.5, entryUsd: 0.0089, nowUsd: 0.0078, peakUsd: 0.0094, unrealizedUsd: -0.19, stopUsd: 0.00623, targetUsd: 0.01602 }], closed: 2, realizedUsd: -0.33, todayUsd: 0, unrealizedUsd: -0.19, valued: true, exitsBy: [{ reason: "stop_loss", count: 2 }], recent: [{ at: at(5 * H), act: "in", token: "DOGEQ", usd: 1.5 }], lab: true },
    test1: { open: [], closed: 3, realizedUsd: -1.1, todayUsd: 0, valued: true, exitsBy: [{ reason: "stop_loss", count: 3 }], recent: [], lab: true },
  } satisfies Record<string, BotBookView>,
}

export const BOTS_FREE: BotsTopic = { gate: { plan: "free", words: "Bots need a Pro or Max plan", fix: "candle plan buy" }, bots: [], problems: [] }
export const BOTS_NONE: BotsTopic = { bots: [], problems: [] }

// Code bots beside them: `momentum` runs here, live on the embedded wallet, with one position whose exits the core
// holds and one its code sells, and a report offering a lower figure; `relay` runs elsewhere and isn't connected.
const momentum: CodeBotView = {
  kind: "code",
  name: "momentum",
  agent: "agent-a",
  wallet: "embedded",
  paysFrom: "embedded",
  mode: "live",
  state: "on",
  buys: true,
  sells: true,
  folder: "/srv/bots/momentum",
  folderShown: "~/candle-bots/momentum",
  command: ["bun", "run", "bot.ts"],
  commandShown: "bun run bot.ts",
  perTradeUsd: 2,
  perDayUsd: 10,
  maxOpen: 3,
  figures: "$2.00 a trade · $10.00 a day · 3 open at most",
  words: "Runs bun run bot.ts in ~/candle-bots/momentum.",
  onSince: at(26 * H),
  usedTodayUsd: 4,
  token: { issuedAt: at(2.2 * H) },
  connected: true,
  process: { runs: "harness", state: "running", words: "running since 07:50 (pid 48211)", pid: 48211, since: at(2.17 * H), crashes: 0, memoryMb: 41, cpuPct: 0.4, log: "/srv/state/bots/momentum.log" },
  heldExits: [{ position: "op-m2", mint: "BonkyFake11111111111111111111111111111111111", symbol: "BONKY", words: "Sells at +80% or at -30%, or after 24 hours.", by: "buy" }],
  says: {
    at: new Date(CLOCK - 12_000).toISOString(),
    status: "watching 38 tokens",
    health: "ok",
    alerts: [],
    rules: ["buys $2 when 3+ tracked wallets buy within 5 min, under $300K"],
    counts: [],
    events: [{ id: "e1", at: at(0.27 * H), kind: "skipped", text: "skipped MOONX: spread 9.4%" }],
    controls: [{ id: "smaller", label: "$1.00 a trade", set: { perTradeUsd: 1 } }],
  },
  controls: [{ id: "smaller", label: "$1.00 a trade", how: "at once", words: "lowers a trade to $1.00, at once" }],
}
const relay: CodeBotView = {
  ...momentum,
  name: "relay",
  agent: "agent-b",
  mode: "paper",
  folder: "/srv/bots/relay",
  folderShown: "~/candle-bots/relay",
  command: ["python3", "relay.py"],
  commandShown: "python3 relay.py",
  perTradeUsd: 1,
  perDayUsd: 5,
  maxOpen: 2,
  figures: "$1.00 a trade · $5.00 a day · 2 open at most",
  words: "Runs python3 relay.py in ~/candle-bots/relay.",
  usedTodayUsd: 0,
  connected: false,
  process: { runs: "outside", state: "outside", words: "runs outside the Candle Harness: no restarts or logs here" },
  heldExits: [],
  controls: [],
}
delete (relay as Partial<CodeBotView>).says

export const BOTS_CODE: BotsTopic = {
  ...BOTS,
  bots: BOTS.bots.filter((b) => b.name === "conf" || b.name === "fresh"),
  code: [momentum, relay],
  books: {
    ...BOTS.books,
    momentum: {
      open: [
        { id: "op-m2", mint: "BonkyFake11111111111111111111111111111111111", token: "BONKY", since: at(0.42 * H), costUsd: 2, entryUsd: 0.0000412, nowUsd: 0.0000379, peakUsd: 0.0000428, unrealizedUsd: -0.16, stopUsd: 0.00002884, targetUsd: 0.00007416, holdUntil: new Date(CLOCK - 0.42 * H + 24 * H).toISOString() },
        { id: "op-m1", mint: "WifyFake1111111111111111111111111111111111111", token: "WIFY", since: at(0.67 * H), costUsd: 2, entryUsd: 0.001204, nowUsd: 0.0013545, peakUsd: 0.00141, unrealizedUsd: 0.25 },
      ],
      closed: 2,
      realizedUsd: -0.4,
      todayUsd: -0.4,
      unrealizedUsd: 0.09,
      valued: true,
      exitsBy: [{ reason: "stop_loss", count: 1 }, { reason: "sold", count: 1 }],
      recent: [
        { at: at(0.42 * H), act: "in", token: "BONKY", usd: 2 },
        { at: at(0.67 * H), act: "in", token: "WIFY", usd: 2 },
        { at: at(1.4 * H), act: "out", token: "MOONQ", reason: "stop_loss", usd: 1.4, realizedUsd: -0.6 },
      ],
      lab: false,
    },
    relay: { open: [], closed: 0, realizedUsd: 0, todayUsd: 0, valued: true, exitsBy: [], recent: [], lab: false },
  },
}
