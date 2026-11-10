// The doctor on rules bots: bots.toml's problems, the bots that trade nothing without a core, and with one each
// bot's state, what holds it and the sells its exits hold, with a live bot's shared wallet as a note only.
import { expect, test } from "bun:test"
import type { BotView } from "../core/bots"
import type { CodeBotView } from "../core/code-bots"
import { botWords, type Check } from "./doctor"

const texts = (checks: Check[]) => checks.map((c) => `${c.state} ${c.area}: ${c.text}`)
const bot = (b: Partial<BotView>): BotView => ({ kind: "rules", name: "conf", agent: "agent-a", wallet: "embedded", mode: "live", state: "on", entries: true, exits: true, words: "", definition: {} as never, ...b })

test("no bot saved, and bots.toml's problems by line", () => {
  expect(texts(botWords({ problems: [], on: [], saved: 0 }))).toEqual(["ok bot: no bot is saved, rules or code"])
  const bad = botWords({ problems: ["bots.toml line 4: state must be on, paused or stopped"], on: [], saved: 0 })
  expect(texts(bad)).toEqual(["warn bot: bots.toml line 4: state must be on, paused or stopped"])
  expect(bad[0]!.fix).toContain("won't write the file")
})

test("no core: bots on trade nothing, and how to start one; none on is plain", () => {
  const on = botWords({ problems: [], on: ["conf", "fresh"], saved: 3 })
  expect(texts(on)).toEqual(["warn bot: 2 bots on in bots.toml, and no core is running, so none enters, and their exits don't sell what they hold"])
  expect(on[0]!.fix).toContain("candle-harness service install")
  expect(texts(botWords({ problems: [], on: [], saved: 2 }))).toEqual(["ok bot: 2 bots in bots.toml, none on"])
})

test("a running core: each bot, what holds it, its held sells, and a shared wallet as a note", () => {
  const checks = botWords({
    problems: [],
    on: ["conf"],
    saved: 5,
    core: {
      botsOn: 2,
      topic: {
        problems: [],
        books: { conf: { open: [{}, {}] } as never },
        bots: [
          bot({ paysFrom: "embedded", sharedWith: ["you and every agent"], sellsHeld: [{ mint: "M", why: "failed_sells", words: "MOON: its exit (a stop at -40%) waits: two sells of MOON in a row failed." }] }),
          bot({ name: "fresh", mode: "paper", wallet: "TeeWa11et1111111111111111111111111111111111", paysFrom: "bot-fresh", sellsHeld: [{ mint: "W", why: "pace", words: "WIF: its exit waits: the key made 20 trades in the last minute." }] }),
          bot({ name: "woke", state: "paused", entries: false, byCandle: true, stateWords: "paused: no new entries, its exits still sell. Candle stopped agent-a's key at 05:02" }),
          bot({ name: "edited", entries: false, held: { code: "CHANGED_OUTSIDE", words: "It was changed in bots.toml since it was approved." } }),
          bot({ name: "test1", state: "stopped", entries: false, exits: false, open: 1, stateWords: "stopped: nothing trades, and its position is left to you, by you at 09:10" }),
        ],
      },
    },
  })
  expect(texts(checks)).toEqual([
    "ok bot: 2 bots keep the core running after the view quits; `candle-harness stop` ends it",
    'ok bot: bot "conf": live · enters and sells · agent-a, pays from embedded · 2 open positions',
    'warn bot: bot "conf": MOON: its exit (a stop at -40%) waits: two sells of MOON in a row failed.',
    'ok bot: bot "conf" trades live from embedded, shared with you and every agent: its book is the Candle Harness\'s count from its own fills, and a wallet of its own would fence what it can lose',
    'ok bot: bot "fresh": paper · enters and sells · agent-a, pays from bot-fresh',
    'ok bot: bot "fresh": WIF: its exit waits: the key made 20 trades in the last minute.',
    "warn bot: bot \"woke\": live · paused: no new entries, its exits still sell. Candle stopped agent-a's key at 05:02 · agent-a, pays from embedded",
    'ok bot: bot "edited": live · on · agent-a, pays from embedded',
    'warn bot: bot "edited" is held: It was changed in bots.toml since it was approved.',
    'ok bot: bot "test1": live · stopped: nothing trades, and its position is left to you, by you at 09:10 · agent-a, pays from embedded · 1 open position',
  ])
  expect(checks[2]!.fix).toContain("retry its sells")
  expect(checks[6]!.fix).toContain("Agent Console")
  expect(checks[8]!.fix).toContain("approve its card")
})

test("Free: no bot enters, its exits still sell, with the plan's step", () => {
  const checks = botWords({ problems: [], on: [], saved: 1, core: { topic: { gate: { plan: "free", words: "Bots need a Pro or Max plan", fix: "candle plan buy" }, problems: [], bots: [bot({ entries: false, held: { code: "PLAN_FREE", words: "The plan is Free now." } })] } } })
  expect(texts(checks).slice(0, 1)).toEqual(["warn bot: Bots need a Pro or Max plan: no bot enters on this plan, and each bot's exits still sell what it holds"])
  expect(checks[0]!.fix).toBe("candle plan buy")
  expect(texts(checks)).toContain('ok bot: bot "conf" is held: The plan is Free now.')
})

const code = (c: Partial<CodeBotView>): CodeBotView => ({
  kind: "code", name: "grid", agent: "agent-a", wallet: "embedded", mode: "paper", state: "on", buys: true, sells: true,
  folder: "/b/grid", folderShown: "~/candle-bots/grid", command: ["bun", "run", "bot.ts"], commandShown: "bun run bot.ts",
  perTradeUsd: 2, perDayUsd: 10, maxOpen: 3, figures: "", words: "", connected: true, ...c,
})

test("no core: code bots counted apart, on ones that run nothing, one that gave up, and a folder that's gone", () => {
  const only = botWords({ problems: [], on: [], saved: 0, code: { saved: 2, on: [] } })
  expect(texts(only)).toEqual(["ok bot: 2 code bots in bots.toml, none on"])
  const checks = botWords({ problems: [], on: ["conf"], saved: 1, code: { saved: 3, on: ["grid", "relay"], gaveUp: [{ name: "grid", crashes: 5 }], noFolder: [{ name: "relay", folder: "/b/relay" }] } })
  expect(texts(checks)).toEqual([
    "warn bot: 1 bot on in bots.toml, and no core is running, so none enters, and their exits don't sell what they hold",
    "warn bot: 2 code bots on in bots.toml, and no core is running, so none runs, and the exits the core holds for them don't sell",
    'warn bot: code bot "grid" crashed 5 times in a row and was given up on: a core won\'t start it again by itself',
    'warn bot: code bot "relay": its folder /b/relay isn\'t there',
  ])
  expect(checks[1]!.fix).toContain("candle-harness service install")
  expect(checks[2]!.fix).toBe("Read why with `candle-harness bots logs grid`, fix its code, then `candle-harness bots start grid`.")
  expect(checks[3]!.fix).toContain("its Build pane")
})

test("a running core: each code bot, its process, its token, a bot run outside, warnings and held exits", () => {
  const checks = botWords({
    problems: [],
    on: [],
    saved: 0,
    code: { saved: 6, on: ["grid"] },
    core: {
      botsOn: 1,
      topic: {
        problems: [],
        bots: [],
        books: { grid: { open: [{}] } as never },
        code: [
          code({ process: { runs: "harness", state: "running", words: "running since 14:02 (pid 4242)", crashes: 1, memoryMb: 41, cpuPct: 0.4 }, heldExits: [{ position: "p1", mint: "M", symbol: "MOON", words: "Sells at +50% or at -20%.", by: "buy", waits: "two sells of MOON in a row failed" }] }),
          code({ name: "loop", process: { runs: "harness", state: "restarting", words: "exit 1; starts again in 8 s (3 crashes in 10 min)" } }),
          code({ name: "gone", process: { runs: "harness", state: "gave_up", words: "crashed 5 times in 10 min, so it isn't started again: `candle-harness bots start gone` runs it again" } }),
          code({ name: "fat", process: { runs: "harness", state: "running", words: "running since 09:00 (pid 7)", warning: "uses 1.2 GB of memory" } }),
          code({ name: "relay", mode: "live", connected: false, process: { runs: "outside", state: "outside", words: "runs outside the Candle Harness: no restarts or logs here" } }),
          code({ name: "far", connected: false, token: { issuedAt: "2026-11-09T10:00:00Z" }, process: { runs: "outside", state: "outside", words: "x" } }),
          code({ name: "test:/b/x", process: { runs: "harness", state: "running", words: "y" } }),
        ],
      },
    },
  })
  expect(texts(checks)).toEqual([
    "ok bot: 1 bot keeps the core running after the view quits; `candle-harness stop` ends it",
    'ok bot: code bot "grid": paper · buys and sells · agent-a, pays from embedded · 1 open position',
    'ok bot: code bot "grid"\'s process: running since 14:02 (pid 4242) · 1 crash in 10 minutes · 41 MB · 0.4% CPU',
    'warn bot: code bot "grid": the exits the core holds on MOON wait: two sells of MOON in a row failed',
    'ok bot: code bot "loop": paper · buys and sells · agent-a, pays from embedded',
    'warn bot: code bot "loop" crashed: exit 1; starts again in 8 s (3 crashes in 10 min)',
    'ok bot: code bot "gone": paper · buys and sells · agent-a, pays from embedded',
    "warn bot: code bot \"gone\"'s process: crashed 5 times in 10 min, so it isn't started again: `candle-harness bots start gone` runs it again",
    'ok bot: code bot "fat": paper · buys and sells · agent-a, pays from embedded',
    'ok bot: code bot "fat"\'s process: running since 09:00 (pid 7)',
    'warn bot: code bot "fat": uses 1.2 GB of memory',
    'ok bot: code bot "relay": live · buys and sells · agent-a, pays from embedded',
    'warn bot: code bot "relay" runs outside the Candle Harness and has no token yet, so it can\'t connect',
    'ok bot: code bot "far": paper · buys and sells · agent-a, pays from embedded',
    'warn bot: code bot "far" runs outside the Candle Harness and isn\'t connected: its buys don\'t run, and the exits the core holds still sell',
  ])
  const fix = (t: string) => checks.find((c) => c.text.startsWith(t))!.fix
  expect(fix('code bot "grid": the exits')).toContain("retry its sells")
  expect(fix('code bot "loop" crashed')).toBe("Read why with `candle-harness bots logs loop`.")
  expect(fix('code bot "gone"\'s process')).toBe("Read why with `candle-harness bots logs gone`, fix its code, then `candle-harness bots start gone`.")
  expect(fix('code bot "fat": uses')).toContain("candle-harness bots logs fat")
  expect(fix('code bot "relay" runs outside')).toBe("Run `candle-harness bots token relay`: it writes the bot's token to .harness-bot.json in its folder, where the client reads it.")
  expect(fix('code bot "far" runs outside')).toContain("candle-harness bots start far")
})

test("a code bot held, stopped by Candle, or selling a held exit", () => {
  const checks = botWords({
    problems: [], on: [], saved: 0, code: { saved: 3, on: [] },
    core: {
      topic: {
        problems: [], bots: [],
        code: [
          code({ held: { code: "CHANGED_OUTSIDE", words: "It was changed in bots.toml since it was approved." }, buys: false }),
          code({ name: "woke", state: "paused", buys: false, byCandle: true, stateWords: "paused: its buys are refused, its sells still run. Candle stopped agent-a's key at 05:02" }),
          code({ name: "sell", heldExits: [{ position: "p", mint: "W", symbol: "WIF", words: "Sells at -20%.", by: "bot", selling: true }, { position: "q", mint: "B", symbol: "BONK", words: "Sells at +30%.", by: "buy" }] }),
        ],
      },
    },
  })
  expect(texts(checks)).toEqual([
    'ok bot: code bot "grid": paper · on · agent-a, pays from embedded',
    'warn bot: code bot "grid" is held: It was changed in bots.toml since it was approved.',
    "warn bot: code bot \"woke\": paper · paused: its buys are refused, its sells still run. Candle stopped agent-a's key at 05:02 · agent-a, pays from embedded",
    'ok bot: code bot "sell": paper · buys and sells · agent-a, pays from embedded',
    'ok bot: code bot "sell": the core is selling its WIF position (Sells at -20%.)',
    'ok bot: code bot "sell": the core holds exits on 1 more open position',
  ])
  expect(checks[1]!.fix).toContain("Build pane")
  expect(checks[2]!.fix).toContain("Agent Console")
})
