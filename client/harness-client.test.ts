// The code bots' client against a real core: every method; a bot in a process of its own; an answer lost to a dropped
// connection asked again under its id, one trade; no trade while not connected; back on its own once the core is; and
// the copy built into the binary is this file.
import { afterAll, afterEach, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, testConfig, testHome, until } from "../test/core-fixture"
import { candleConfigDir } from "../src/core/candle-mcp"
import type { CodeBotProposal } from "../src/core/code-bots"
import { startCore } from "../src/core/core-main"
import { HARNESS_CLIENT_SOURCE } from "../src/shared/harness-client-source"
import { HarnessClient, HarnessRefused, NotConnected, type Report, type Told } from "./harness-client"

const MOON = "MoonFake11111111111111111111111111111111111"
const PEPE = "PepeFake11111111111111111111111111111111111"
const BOT = { name: "client-bot", wallet: "embedded", mode: "paper", folder: "/srv/bots/client", command: ["bun", "run", "bot.ts"], perTradeUsd: 2, perDayUsd: 10, maxOpen: 3 }

const cores: TestCore[] = []
const clients: HarnessClient[] = []
afterEach(async () => {
  for (const h of clients.splice(0)) h.close()
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(() => cleanupHomes())

const trades = (c: { p: TestCore["p"] }) => {
  const file = join(candleConfigDir(c.p.stateDir, "momentum"), "fake-candle-calls.jsonl")
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { name: string; args: Record<string, unknown> })
        .filter((x) => x.name === "candle_trade")
    : []
}

async function withBot() {
  const c = await startTestCore({ env: process.env })
  cores.push(c)
  const view = await c.view()
  const minted = await c.core.tokens.mintBuild("Build pane", "momentum")
  const { client: build } = await c.hello(minted.token)
  const probe: CodeBotProposal = { name: "probe", run: { agent: "momentum", ...BOT } as CodeBotProposal["run"] }
  await until(() => {
    try {
      c.core.codeBots.check(probe, "momentum")
      return true
    } catch {
      return false
    }
  })
  const proposed = await build.request("bots.proposeCode", BOT)
  const card = c.core.cards.get((proposed.result as { cardId: string }).cardId)!
  await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })
  await until(() => c.core.operations.get(card.opId)?.state === "succeeded")
  const { token } = await c.core.codeBots.issueToken(BOT.name, "outside")
  return { c, view, token }
}

async function connect(socket: string, token: string) {
  const h = await HarnessClient.connect({ socket, token })
  clients.push(h)
  return h
}

test("every method against a real core", async () => {
  const { c, view, token } = await withBot()
  const h = await connect(c.p.socket, token)
  expect(h.who).toEqual({ agent: "momentum", bot: BOT.name })
  const states: Told[] = []
  h.on("state", (t) => states.push(t))
  expect(await h.self()).toMatchObject({ name: BOT.name, mode: "paper", figures: { perTradeUsd: 2, perDayUsd: 10, maxOpen: 3 } })

  const bought = await h.buy({ mint: MOON, amountUsd: 1 })
  expect(bought).toMatchObject({ side: "buy", state: "filled", mint: MOON })
  expect(await h.request(bought.request)).toMatchObject({ state: "filled" })
  expect(await h.request("req_never_asked")).toMatchObject({ state: "unknown" })
  const { positions } = await h.positions()
  expect(positions).toHaveLength(1)
  expect(await h.sell({ position: positions[0]!.id, percent: 50 })).toMatchObject({ state: "filled" })
  expect(await h.sell({ mint: MOON })).toMatchObject({ state: "filled" })
  expect((await h.fills()).fills.map((f) => f.side)).toEqual(["sell", "sell", "buy"])
  expect((await h.market(PEPE)).market).toMatchObject({ mint: PEPE })

  // Exits the core holds: carried on a buy, then changed and cleared.
  await h.buy({ mint: PEPE, amountUsd: 1, exits: { stop_loss_pct: 30, max_hold_hours: 4 } })
  const held = (await h.positions()).positions.find((p) => p.mint === PEPE)!
  expect(held.exits).toEqual({ stop_loss_pct: 30, max_hold_hours: 4, by: "buy" })
  expect(await h.setExits({ position: held.id }, { take_profit_pct: 50 })).toMatchObject({ exits: { take_profit_pct: 50 } })
  expect(await h.setExits({ mint: PEPE }, null)).toMatchObject({ exits: null })
  expect(await h.setExits({ mint: PEPE }, { stop_loss_pct: 0 }).catch((e: HarnessRefused) => e.code)).toBe("INVALID_PARAMS")
  await h.sell({ mint: PEPE })

  // Refusals carry the core's code and words.
  const over = await h.buy({ mint: MOON, amountUsd: 5 }).catch((e) => e)
  expect(over).toBeInstanceOf(HarnessRefused)
  expect(over).toMatchObject({ code: "FIGURE_TRADE" })
  expect(await h.swap({ from: "SOL", to: "USDC", amount: "0.01" }).catch((e: HarnessRefused) => e.code)).toBe("NO_PAPER_SWAPS")
  expect(await h.hacc("hacc_signals", { view: "tape" }).catch((e: HarnessRefused) => e.code)).toBe("HACC_OFF")
  await h.signals(() => {})
  // What it says about itself: kept, and refused whole when it names a figure the core counts.
  expect(await h.report({ status: "watching", counts: { watching: 3 }, events: [{ kind: "considered", text: "MOON on the tape", mint: MOON }] })).toMatchObject({ events: 1 })
  expect(await h.report({ status: "up", ...({ pnl: 1 } as object) }).catch((e: HarnessRefused) => e.code)).toBe("REPORT_FIGURES")
  // The chips it offers the person are part of a report as the client types it: a pause, or figures of its card.
  const offering: Report = { controls: [{ id: "hold", label: "Pause me", pause: true }, { id: "calm", label: "Calm down: $1 a trade", set: { perTradeUsd: 1 } }] }
  await h.report(offering)
  const shown = (await view.request("bots.list", {})).result as { code: { name: string; controls?: { id: string }[] }[] }
  expect(shown.code.find((b) => b.name === BOT.name)?.controls?.map((x) => x.id)).toEqual(["hold", "calm"])
  // What it says, a word a trigger can wait on: one of a word every 10 s.
  expect(await h.event("needs-a-look", "spread above 8%")).toMatchObject({ word: "needs-a-look" })
  expect(await h.event("needs-a-look").catch((e: HarnessRefused) => e.code)).toBe("TOO_SOON")

  // What happens to it: paused, then on again.
  await view.request("bots.pause", { name: BOT.name })
  await until(() => states.some((t) => t.kind === "state" && t.state === "paused"))
  expect(await h.buy({ mint: MOON, amountUsd: 1 }).catch((e: HarnessRefused) => e.code)).toBe("BUYS_HELD")
})

test("a bot in a process of its own makes a round trip through the shipped client", async () => {
  const { c, token } = await withBot()
  const child = Bun.spawn(["bun", join(import.meta.dir, "..", "test", "fake-bot.ts")], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CANDLE_HARNESS_SOCKET: c.p.socket, CANDLE_HARNESS_BOT_TOKEN: token },
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = await new Response(child.stdout).text()
  expect(await child.exited).toBe(0)
  const steps = Object.fromEntries(
    out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { step: string; value: unknown })
      .map((s) => [s.step, s.value]),
  )
  expect(steps.buy).toMatchObject({ state: "filled" })
  expect(steps["sell-half"]).toMatchObject({ state: "filled" })
  expect(steps["sell-rest"]).toMatchObject({ state: "filled" })
  expect(steps.over).toMatchObject({ code: "FIGURE_TRADE" })
  expect(trades(c)).toHaveLength(3)
  // The token never reached its output.
  expect(out).not.toContain(token)
})

test("an answer lost to a dropped connection is asked again under its id: one trade", async () => {
  const { c, token } = await withBot()
  const h = await connect(c.p.socket, token)
  const pending = h.buy({ mint: MOON, amountUsd: 1 })
  // The connection drops as the request goes out.
  ;(h as unknown as { socket: { destroy(): void } }).socket.destroy()
  const answer = await pending
  expect(answer).toMatchObject({ state: "filled" })
  expect(trades(c)).toHaveLength(1)
  expect(c.core.journal.rows().filter((r) => r.type === "bot.request" && r.request === answer.request)).toHaveLength(1)
})

test("no trade while not connected; back on its own when the core is, under the same token", async () => {
  const { c, token } = await withBot()
  const h = await connect(c.p.socket, token)
  const told: Told[] = []
  h.on("stopping", (t) => told.push(t))
  const p = c.p
  cores.splice(cores.indexOf(c), 1)
  await c.close()
  await until(() => !h.isConnected)
  expect(told).toEqual([expect.objectContaining({ kind: "stopping" })])
  expect(await h.buy({ mint: MOON, amountUsd: 1 }).catch((e) => e)).toBeInstanceOf(NotConnected)
  const again = await startCore({ paths: p, config: testConfig((await testHome()).candle), env: process.env, headless: true })
  try {
    await again.candleReady
    await until(() => h.isConnected, 15_000)
    expect(await h.buy({ mint: MOON, amountUsd: 1 })).toMatchObject({ state: "filled" })
  } finally {
    h.close()
    await again.stop("test")
  }
}, 30_000)

test("the client built into the binary is this file", () => {
  expect(HARNESS_CLIENT_SOURCE).toBe(readFileSync(join(import.meta.dir, "harness-client.ts"), "utf8"))
})
