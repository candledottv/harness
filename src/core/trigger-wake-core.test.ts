// Waking an agent for a trigger, through a real core and a scripted engine: the woken turn opens with what
// woke it and is never worded as the person's; its trades run as the person's would (inside the wallet's
// figures with a receipt marked with the trigger); funds out never starts from it; wakes while the agent is
// busy join one turn, counted once; the caps hold on a clock, and across a restart; the kill switch stops a
// woken turn and holds the next wake; a woken turn's fill never wakes its trigger again.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, testConfig, testHome, until } from "../../test/core-fixture"
import { connectTestClient } from "../../test/core-test-client"
import { type Script, scripted } from "../../test/scripted-engine"
import type { EngineTurn } from "../engine/engine"
import { PROTOCOL_VERSION } from "../shared/rpc"
import { startCore } from "./core-main"
import type { JournalRow } from "./journal"

const FAKE_WALLET = "WalletFake111111111111111111111111111111111"
const MOON = "MoonFake11111111111111111111111111111111111"
const VAULT = "VaultFake11111111111111111111111111111111111"
const TEE = "TeeFake111111111111111111111111111111111111"
const INSIDE = { wallet: "embedded", setting: "inside", perTradeUsd: 2, perDayUsd: 4 }
const LIMITS = { perTradeUsd: 10, perDayUsd: 50 }

const cores: TestCore[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  cleanupHomes()
})

const rows = (c: TestCore, type: string): JournalRow[] => c.core.journal.rows().filter((r) => r.type === type)
const turns = (c: TestCore) => rows(c, "agent.turn")

/** A fake CLI that knows a vault key and a TEE wallet, so a funds-out call gets as far as asking who asked. */
const fakeCli = () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-cli-"))
  dirs.push(dir)
  const ownerWallets = {
    embedded: { success: true, wallets: { solana: { address: FAKE_WALLET, delegated: true } } },
    linked: { success: true, isDone: true, page: [{ address: TEE, label: "tee-one", walletKind: "tee", chain: "solana", vaultDestination: VAULT }] },
  }
  writeFileSync(join(dir, "fake-cli.json"), JSON.stringify({ vault: { passphrase: "correct horse battery staple" }, ownerWallets }))
  return dir
}

/**
 * A core whose engine plays `plays` in order, one a run, then answers "ok". Each play gets a `call` that
 * calls a tool through the token the turn was minted, as the harness would.
 */
type Play = (turn: EngineTurn, call: (name: string, args: Record<string, unknown>) => Promise<Record<string, any>>, cancelled: Promise<void>) => Promise<string | undefined>
async function core(o: { plays?: Play[]; config?: Record<string, unknown>; now?: () => number; inside?: boolean; home?: string } = {}) {
  const plays = [...(o.plays ?? [])]
  let socket = ""
  const call = (turn: EngineTurn) => async (name: string, args: Record<string, unknown>) => {
    const config = JSON.parse(readFileSync(turn.mcpConfig, "utf8")) as { mcpServers: { candle: { args: string[] } } }
    const token = readFileSync(config.mcpServers.candle.args.at(-1)!, "utf8").trim()
    const client = await connectTestClient(socket)
    await client.request("core.hello", { protocol: PROTOCOL_VERSION, token, clientName: "engine" })
    const answer = await client.request("tools.call", { name, args })
    client.close()
    return JSON.parse((answer.result as { content: { text: string }[] }).content[0]!.text) as Record<string, any>
  }
  const script: Script = async (turn, push, cancelled) => {
    const play = plays.shift()
    const text = play ? await play(turn, call(turn), cancelled) : "ok"
    push({ type: "done", text: text ?? "ok" })
  }
  const engine = scripted([script])
  const c = await startTestCore(
    { env: { ...process.env, CANDLE_CONFIG_DIR: o.home ?? fakeCli() }, engine: { start: engine.start, version: () => ({ ok: true, version: "2.1.310" }), processes: () => [], leftoverDelayMs: 10 }, ...(o.now ? { now: o.now } : {}) },
    o.config ? { config: o.config as never } : {},
  )
  cores.push(c)
  socket = c.p.socket
  const view = await c.view()
  await view.request("subscribe", { topics: ["autonomy", "cards", "activity", "agent"] })
  await until(() => ["pro", "max"].includes(String(c.core.plans.planFor("momentum").plan)))
  if (o.inside !== false) {
    await until(() => view.events.some((e) => e.topic === "autonomy" && (e.data as { wallets: { wallet: string }[] }).wallets.some((w) => w.wallet === FAKE_WALLET)))
    await view.request("autonomy.set", INSIDE)
  }
  return { c, view, runs: engine.runs }
}

/** Saves a trigger as its card's press would, and answers its name. */
async function save(c: TestCore, line: string) {
  const check = c.core.triggers.check(line, "momentum")
  return (await c.core.triggers.save(line, "momentum", { expansion: check.trigger.expansion })).name
}

/** Fires an `on call` trigger and answers what its wake did. */
async function fire(c: Pick<TestCore, "core">, name: string) {
  const { run } = await c.core.triggers.fire(name, { clientId: "test" })
  return (await run) as { kind: string }
}

const activity = (view: { events: { topic: string; data: unknown }[] }) =>
  view.events.filter((e) => e.topic === "activity").flatMap((e) => {
    const d = e.data as { entry?: { text: string }; lines?: { text: string }[] }
    return d.lines ? d.lines.map((l) => l.text) : d.entry ? [d.entry.text] : []
  })

describe("a woken turn", () => {
  test("a turn of its own, opening with what woke it, fenced as data; never the person's words", async () => {
    const { c, view, runs } = await core()
    const name = await save(c, `on call wake momentum "look at MOON's chart" as "look"`)
    expect(await fire(c, name)).toMatchObject({ kind: "woke" })
    await until(() => turns(c).length === 1)
    const prompt = runs[0]!.prompt
    expect(prompt).toContain("\n\nA trigger woke you. The person didn't write this, and may not be watching.\n\n<trigger-fired>")
    expect(prompt).toContain(`<trigger-fired>\n- the trigger "look" (on call wake momentum "look at MOON's chart") fired at `)
    expect(prompt).toContain(": someone called it from outside\n</trigger-fired>")
    expect(prompt).toContain(`When they set it up, the person asked:\n- for "look": "look at MOON's chart"`)
    expect(prompt).not.toContain("The person now says")
    const fired = rows(c, "trigger.fired")[0]!
    const turn = turns(c)[0]!
    expect(turn).toMatchObject({ woken: ["look"], fireIds: [fired.fireId], user: 'woken by the trigger "look": someone called it from outside' })
    expect(rows(c, "agent.turn_started")[0]).toMatchObject({ woken: ["look"] })
    expect(rows(c, "trigger.woke")[0]).toMatchObject({ name: "look", fireId: fired.fireId, woke: "momentum", turnId: turn.turnId })
    expect(rows(c, "trigger.woke")[0]!.joined).toBeUndefined()
    const started = view.events.find((e) => e.topic === "agent" && (e.data as { type?: string }).type === "started")?.data
    expect(started).toMatchObject({ woken: ["look"] })
    await until(() => activity(view).some((t) => t.startsWith('trigger "look" woke momentum: someone called it from outside')))

    // The next turn, the person's, carries it in the conversation as the trigger's, not the person's.
    await view.request("agent.send", { text: "what did you find?" })
    await until(() => turns(c).length === 2)
    expect(runs[1]!.prompt).toContain('Trigger (not the person): woken by the trigger "look": someone called it from outside\nYou: ok')
    expect(runs[1]!.prompt).toContain("The person now says:\nwhat did you find?")
  }, 30_000)

  test("its buy inside the wallet's figures runs with a receipt marked with the trigger that woke it", async () => {
    let answer: Record<string, any> | undefined
    const { c, view } = await core({
      plays: [
        async (_turn, call) => {
          answer = await call("candle_trade", { mint: MOON, side: "buy", amount: "0.01", quoteAsset: "sol" })
          return "bought"
        },
      ],
    })
    await fire(c, await save(c, `on call wake momentum as "conf"`))
    await until(() => turns(c).length === 1)
    expect(answer).toBeDefined()
    const card = c.core.cards.list().find((x) => x.agent === "momentum")!
    expect(card.origin).toMatchObject({ role: "harness", source: "agent", woken: { trigger: "conf" } })
    expect(card.origin.trigger).toBeUndefined()
    expect(card.display.woken).toBe("conf")
    expect(rows(c, "card.created")[0]).toMatchObject({ woken: "conf", wokenFireId: rows(c, "trigger.fired")[0]!.fireId })
    expect(rows(c, "card.approved")[0]).toMatchObject({ how: "inside-limits" })
    await until(() => c.core.operations.get(card.opId)?.state === "succeeded")
    await until(() => activity(view).some((t) => t.startsWith('woke on trigger "conf" · momentum proposed BUY')))
    await until(() => activity(view).some((t) => / · without a card · woke on trigger "conf"$/.test(t)))
  }, 30_000)

  test("funds out never starts from it: a woken turn isn't the person asking", async () => {
    let answer: Record<string, any> | undefined
    const { c } = await core({
      inside: false,
      plays: [
        async (_turn, call) => {
          answer = await call("candle_cli", { command: "vault", subcommand: "transfer", args: ["cold", "--amount", "0.01", "--asset", "SOL", "--from", "tee-one"] })
          return "tried"
        },
      ],
    })
    await c.core.destinations.setVaultList([{ address: VAULT, label: "cold", kind: "vault-key" }])
    await fire(c, await save(c, `on call wake momentum "send 0.01 SOL from tee-one to cold" as "send"`))
    await until(() => turns(c).length === 1)
    expect(answer).toMatchObject({ success: false, error: { code: "ASK_FOR_IT_YOURSELF" } })
    expect(String(answer!.error.message)).toContain("there's no message from the user this turn")
    expect(c.core.cards.list().filter((x) => x.kind === "funds-out")).toEqual([])
  }, 30_000)
})

describe("how often", () => {
  test("wakes while the agent is busy join one woken turn, which counts once toward its caps", async () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const { c, runs } = await core({
      plays: [
        async () => {
          await held
          return "first"
        },
      ],
    })
    const [a, b, d] = [await save(c, `on call wake momentum as "a"`), await save(c, `on call wake momentum as "b"`), await save(c, `on call wake momentum as "d"`)]
    await fire(c, a)
    await until(() => runs.length === 1)
    await fire(c, b)
    await fire(c, d)
    const woke = rows(c, "trigger.woke")
    expect(woke.map((r) => [r.name, r.joined === true])).toEqual([
      ["a", false],
      ["b", false],
      ["d", true],
    ])
    expect(woke[2]!.turnId).toBe(woke[1]!.turnId)
    release()
    await until(() => turns(c).length === 2)
    expect(runs).toHaveLength(2)
    expect(runs[1]!.prompt).toContain('- the trigger "b" (on call wake momentum) fired at ')
    expect(runs[1]!.prompt).toContain('- the trigger "d" (on call wake momentum) fired at ')
    expect(turns(c)[1]).toMatchObject({ woken: ["b", "d"], user: 'woken by 2 triggers, joined while the agent was busy:\n- "b": someone called it from outside\n- "d": someone called it from outside' })
  }, 30_000)

  test("the caps, on a clock: past perHour or perDay a wake is skipped and said; they hold across a restart", async () => {
    let clock = Date.parse("2026-11-04T12:00:00Z")
    const now = () => clock
    const agents = { momentum: { name: "momentum", limits: LIMITS, wake: { perHour: 2, perDay: 3 } }, swing: { name: "swing", limits: LIMITS } }
    const { c } = await core({ now, config: { agents }, inside: false })
    const names: string[] = []
    for (const n of ["one", "two", "three", "four", "five"]) names.push(await save(c, `on call wake momentum as "${n}"`))
    const wakeAndEnd = async (name: string) => {
      const before = turns(c).length
      const did = await fire(c, name)
      if (did.kind === "woke") await until(() => turns(c).length === before + 1)
      return did
    }
    expect(await wakeAndEnd(names[0]!)).toMatchObject({ kind: "woke" })
    expect(await wakeAndEnd(names[1]!)).toMatchObject({ kind: "woke" })
    expect(await wakeAndEnd(names[2]!)).toMatchObject({ kind: "skipped" })
    expect(rows(c, "trigger.wake_skipped").at(-1)).toMatchObject({ name: "three", woke: "momentum", words: "momentum was woken twice in the last hour, its most (wake.perHour = 2), so it wasn't woken" })
    clock += 61 * 60_000
    expect(await wakeAndEnd(names[2]!)).toMatchObject({ kind: "woke" })
    expect(turns(c)).toHaveLength(3)

    // A restart reads the caps back from the journal: the day's third is in, so a fourth is skipped.
    clock += 61 * 60_000
    const p = c.p
    cores.splice(cores.indexOf(c), 1)
    await c.close()
    const engine = scripted([async (_t, push) => push({ type: "done", text: "ok" })])
    const again = await startCore({ paths: p, config: testConfig((await testHome()).candle, { agents } as never), env: { ...process.env, CANDLE_CONFIG_DIR: fakeCli() }, headless: true, now, engine: { start: engine.start, version: () => ({ ok: true, version: "2.1.310" }), processes: () => [], leftoverDelayMs: 10 } })
    try {
      await again.candleReady
      await until(() => ["pro", "max"].includes(String(again.plans.planFor("momentum").plan)))
      expect(await fire({ core: again }, names[3]!)).toMatchObject({ kind: "skipped" })
      expect(again.journal.rows().filter((r) => r.type === "trigger.wake_skipped").at(-1)!.words).toBe("momentum was woken 3 times in the last 24 hours, its most (wake.perDay = 3), so it wasn't woken")
    } finally {
      await again.stop("test")
    }
  }, 60_000)
})

describe("the kill switch", () => {
  test("stops a woken turn mid-turn, and holds the next wake until resume", async () => {
    const { c, view, runs } = await core({
      inside: false,
      plays: [
        async (_t, _call, cancelled) => {
          await cancelled
          return undefined
        },
      ],
    })
    await fire(c, await save(c, `on call wake momentum as "w"`))
    await until(() => runs.length === 1)
    await view.request("kill", {})
    await until(() => turns(c).length === 1)
    expect(turns(c)[0]).toMatchObject({ outcome: "cancelled", woken: ["w"] })
    expect(await fire(c, await save(c, `on call wake momentum as "w2"`))).toMatchObject({ kind: "held" })
    expect(rows(c, "trigger.held").at(-1)).toMatchObject({ name: "w2", reason: "paused", words: "the kill switch holds its wake of momentum, so momentum wasn't woken" })
    await Bun.sleep(50)
    expect(runs).toHaveLength(1)
  }, 30_000)
})

describe("on fill", () => {
  test("a woken turn's fill never wakes the trigger that woke it again", async () => {
    const plays: Play[] = [async (_t, call) => (await call("candle_trade", { mint: MOON, side: "buy", amount: "0.01", quoteAsset: "sol" }), "bought")]
    const { c, view, runs } = await core({ plays })
    await save(c, `on fill of ${MOON} wake momentum as "refill"`)
    // The person's own buy fills: "refill" wakes momentum, whose buy fills too.
    const typed = await view.request("cards.propose", { tool: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.01", quoteAsset: "sol" } })
    expect(typed.error).toBeUndefined()
    await until(() => turns(c).length === 1)
    await until(() => c.core.operations.list().filter((op) => op.state === "succeeded").length === 2)
    await Bun.sleep(200)
    expect(rows(c, "trigger.fired").filter((r) => r.name === "refill")).toHaveLength(1)
    expect(runs).toHaveLength(1)
  }, 30_000)
})
