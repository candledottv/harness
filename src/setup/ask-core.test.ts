// `candle-harness ask` and `candle-harness trigger <name>` against a real core and a scripted engine: neither starts a
// core; `ask` is the person's message under the same rules, its reply printed, marked from outside in the
// conversation, the prompt, Activity, the Journal and the agent's record, with the cards its turn left waiting
// named; `trigger` fires an `on call` trigger as its own condition would, printing its Activity line, with its
// cooldown and the kill switch; and neither client counts as the person's open Candle Harness. Each has its exit code.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupHomes, startTestCore, type TestCore, testHome, until } from "../../test/core-fixture"
import { connectTestClient } from "../../test/core-test-client"
import { type Script, scripted } from "../../test/scripted-engine"
import { candleConfigDir } from "../core/candle-mcp"
import type { JournalRow } from "../core/journal"
import type { EngineTurn } from "../engine/engine"
import { PROTOCOL_VERSION } from "../shared/rpc"
import { CARDS_CLIENT } from "../core/client"
import { askCommand, EXIT, triggerCommand } from "./ask"
import { cardRow, cardsCommand } from "./cards"

const FAKE_WALLET = "WalletFake111111111111111111111111111111111"
const MOON = "MoonFake11111111111111111111111111111111111"
const INSIDE = { wallet: "embedded", setting: "inside", perTradeUsd: 2, perDayUsd: 4 }

const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(cleanupHomes)

const io = (stdin?: string) => {
  const out: string[] = []
  const err: string[] = []
  return {
    text: () => out.join(""),
    errors: () => err.join(""),
    io: { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t), ...(stdin !== undefined ? { readStdin: async () => stdin } : {}) },
  }
}
const rows = (c: TestCore, type: string): JournalRow[] => c.core.journal.rows().filter((r) => r.type === type)
const envOf = (c: TestCore) => ({ env: { ...process.env, CANDLE_HARNESS_HOME: c.p.configDir } })
const trades = (c: TestCore) => {
  const file = join(candleConfigDir(c.p.stateDir, "momentum"), "fake-candle-calls.jsonl")
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { name: string })
        .filter((x) => x.name === "candle_trade")
    : []
}
const activity = (view: { events: { topic: string; data: unknown }[] }) =>
  view.events.filter((e) => e.topic === "activity").flatMap((e) => {
    const d = e.data as { entry?: { text: string }; lines?: { text: string }[] }
    return d.lines ? d.lines.map((l) => l.text) : d.entry ? [d.entry.text] : []
  })

type Play = (turn: EngineTurn, call: (name: string, args: Record<string, unknown>) => Promise<Record<string, any>>) => Promise<string | undefined>

/** A core whose engine plays `plays` in order, then answers "ok"; a play may call a tool as the harness would. */
async function core(o: { plays?: Play[]; inside?: boolean; fail?: boolean } = {}) {
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
  const script: Script = async (turn, push) => {
    if (o.fail) return push({ type: "error", message: "the model provider refused the request" })
    const play = plays.shift()
    push({ type: "done", text: (play ? await play(turn, call(turn)) : undefined) ?? "ok" })
  }
  const engine = scripted([script])
  const c = await startTestCore({ engine: { start: engine.start, version: () => ({ ok: true, version: "2.1.310" }), processes: () => [], leftoverDelayMs: 10 } })
  cores.push(c)
  socket = c.p.socket
  const view = await c.view()
  await view.request("subscribe", { topics: ["autonomy", "activity", "agent"] })
  await until(() => ["pro", "max"].includes(String(c.core.plans.planFor("momentum").plan)))
  if (o.inside) {
    await until(() => view.events.some((e) => e.topic === "autonomy" && (e.data as { wallets: { wallet: string }[] }).wallets.some((w) => w.wallet === FAKE_WALLET)))
    await view.request("autonomy.set", INSIDE)
  }
  return { c, view, runs: engine.runs }
}

async function save(c: TestCore, line: string) {
  const check = c.core.triggers.check(line, "momentum")
  return (await c.core.triggers.save(line, "momentum", { expansion: check.trigger.expansion })).name
}

describe("no core running", () => {
  test("neither starts one: each says so and how to start one, exit 3", async () => {
    const { home, p } = await testHome()
    const env = { env: { ...process.env, CANDLE_HARNESS_HOME: home } }
    const a = io()
    expect(await askCommand(["how", "am", "I", "doing?"], a.io, env)).toBe(EXIT.noCore)
    expect(a.errors()).toStartWith("No Candle Harness core is running, so nothing was sent. `candle-harness` opens the Candle Harness and starts one; `candle-harness core` runs one headless")
    const t = io()
    expect(await triggerCommand(["dip"], t.io, env)).toBe(EXIT.noCore)
    expect(t.errors()).toStartWith("No Candle Harness core is running")
    expect(existsSync(p.socket)).toBe(false)
    expect(existsSync(p.lock)).toBe(false)
  })

  test("usage: no words, no name, or an unknown option, exit 2", async () => {
    const env = { env: process.env }
    expect(await askCommand([], io("").io, env)).toBe(EXIT.usage)
    expect(await askCommand(["--agent"], io().io, env)).toBe(EXIT.usage)
    expect(await askCommand(["--loud", "hi"], io().io, env)).toBe(EXIT.usage)
    expect(await triggerCommand([], io().io, env)).toBe(EXIT.usage)
    expect(await triggerCommand(["--agent", "momentum", "dip"], io().io, env)).toBe(EXIT.usage)
  })
})

describe("candle-harness ask", () => {
  test("the turn's reply printed, exit 0; marked from outside in the prompt, the conversation, Activity, the Journal and the agent's record", async () => {
    const { c, view, runs } = await core({ plays: [async () => "Up $1.20 today. No trades.", async () => "ok"] })
    const t = io()
    expect(await askCommand(["how", "am", "I", "doing?"], t.io, envOf(c))).toBe(EXIT.done)
    expect(t.text()).toBe("Up $1.20 today. No trades.\n")
    expect(t.errors()).toBe("")
    expect(runs[0]!.prompt).toMatch(/^It's \d\d:\d\d on .+ on this machine \(.+\)\. .+\n\nThe person now says, from outside the Candle Harness \(a script or another terminal\):\nhow am I doing\?$/)
    const turn = rows(c, "agent.turn")[0]!
    expect(turn).toMatchObject({ agent: "momentum", user: "how am I doing?", outside: true, outcome: "done" })
    expect(rows(c, "agent.turn_started")[0]).toMatchObject({ outside: true, user: "how am I doing?" })
    const started = view.events.find((e) => e.topic === "agent" && (e.data as { type?: string }).type === "started")?.data
    expect(started).toMatchObject({ user: "how am I doing?", outside: true })
    await until(() => activity(view).includes('you asked momentum from outside: "how am I doing?"'))
    const journal = (await view.request("journal.query", { kinds: ["agents"] })).result as { entries: { text: string }[] }
    expect(journal.entries.some((e) => e.text.startsWith('you asked momentum from outside: "how am I doing?" · answered'))).toBe(true)

    // The next turn's conversation carries it as the person's, from outside; one typed in the Candle Harness isn't marked.
    await view.request("agent.send", { text: "and now?" })
    await until(() => runs.length === 2)
    expect(runs[1]!.prompt).toContain("Person (from outside the Candle Harness): how am I doing?\nYou: Up $1.20 today. No trades.")
    expect(runs[1]!.prompt).toEndWith("The person now says:\nand now?")
    await until(() => rows(c, "agent.turn").length === 2)
    expect(rows(c, "agent.turn")[1]!.outside).toBeUndefined()
  })

  test("--agent picks the agent, stdin carries the words, --no-wait returns once the core has it", async () => {
    const { c } = await core({ plays: [async () => "swing here"] })
    const t = io("what do you hold?\n")
    expect(await askCommand(["--agent", "swing", "--no-wait"], t.io, envOf(c))).toBe(EXIT.done)
    expect(t.text()).toBe("Sent to swing. Its reply shows in the Candle Harness.\n")
    await until(() => rows(c, "agent.turn").length === 1)
    expect(rows(c, "agent.turn")[0]).toMatchObject({ agent: "swing", user: "what do you hold?", outside: true })
  })

  test("the same rules: a secret is refused and never reaches the engine, exit 4", async () => {
    const { c, runs } = await core()
    const key = `${["cndl", "live", ""].join("_")}${"Q".repeat(43)}`
    const t = io()
    expect(await askCommand(["use", "this", "key", key], t.io, envOf(c))).toBe(EXIT.refused)
    expect(t.errors()).toContain("That message holds something that looks like a key or secret, so it wasn't sent to the agent.")
    expect(t.errors()).not.toContain(key)
    expect(runs).toHaveLength(0)
    expect(rows(c, "agent.message_refused")[0]).toMatchObject({ code: "SECRET_IN_MESSAGE" })
  })

  test("a card the turn proposed waits for a press in the Candle Harness: named on stderr, the reply on stdout", async () => {
    const { c } = await core({
      plays: [
        async (_turn, call) => {
          const r = await call("candle_trade", { side: "buy", mint: MOON, amount: "0.01", reason: "asked" })
          return `Proposed: ${String(r.code ?? r.state)}`
        },
      ],
    })
    const t = io()
    expect(await askCommand(["buy", "0.01", "sol", "of", MOON], t.io, envOf(c))).toBe(EXIT.done)
    expect(t.text()).toBe("Proposed: awaiting_approval\n")
    expect(t.errors()).toMatch(/^A card waits for you in the Candle Harness: .*MOON.*\. Only a press there approves it\.\n$/)
    expect(c.core.cards.list().filter((x) => x.state === "awaiting_approval")).toHaveLength(1)
    expect(trades(c)).toHaveLength(0)
  })

  test("--json: the turn, its reply, how it ended and the card it left waiting, as one object; --no-wait gives the turn alone", async () => {
    const { c } = await core({
      plays: [
        async (_turn, call) => {
          await call("candle_trade", { side: "buy", mint: MOON, amount: "0.01", reason: "asked" })
          return "Proposed the buy."
        },
      ],
    })
    const t = io()
    expect(await askCommand(["--json", "buy", "0.01", "sol", "of", MOON], t.io, envOf(c))).toBe(EXIT.done)
    const said = JSON.parse(t.text()) as { agent: string; turnId: string; queued: boolean; outcome: string; reply: string; cards: Record<string, unknown>[] }
    const card = c.core.cards.list()[0]!
    expect(said).toMatchObject({ agent: "momentum", queued: false, outcome: "done", reply: "Proposed the buy." })
    expect(said.turnId).toStartWith("t_")
    expect(said.cards).toHaveLength(1)
    expect(said.cards[0]).toMatchObject({ cardId: card.cardId, opId: card.opId, kind: "trade", agent: "momentum", state: "waiting", final: false, expiresAt: card.expiresAt })
    expect(String(said.cards[0]!.title)).toContain("MOON")
    // Still said for a person reading stderr: only a press approves it.
    expect(t.errors()).toContain("Only a press there approves it.")
    const quick = io()
    expect(await askCommand(["--json", "--no-wait", "and", "again"], quick.io, envOf(c))).toBe(EXIT.done)
    expect(JSON.parse(quick.text())).toMatchObject({ agent: "momentum", queued: false })
    // trigger takes no --json.
    expect(await triggerCommand(["--json", "x"], io().io, envOf(c))).toBe(EXIT.usage)
  })

  test("a turn that fails prints why and exits 1", async () => {
    const { c } = await core({ fail: true })
    const t = io()
    expect(await askCommand(["hello"], t.io, envOf(c))).toBe(EXIT.failed)
    expect(t.text()).toContain("the model provider refused the request")
  })

  test("the kill switch on: said, and the message still goes (the agent's buys are what it refuses)", async () => {
    const { c, view } = await core({ plays: [async () => "noted"] })
    await view.request("kill", {})
    const t = io()
    expect(await askCommand(["hello"], t.io, envOf(c))).toBe(EXIT.done)
    expect(t.errors()).toBe("The kill switch is on: the agent's buys and swaps are refused until you resume in the Candle Harness.\n")
    expect(t.text()).toBe("noted\n")
  })

  test("not the person's open Candle Harness: its leaving doesn't end a session", async () => {
    const { c } = await core({ plays: [async () => "ok"] })
    expect(await askCommand(["hello"], io().io, envOf(c))).toBe(EXIT.done)
    await until(() => rows(c, "client.detached").some((r) => r.role === "view"))
    const window = existsSync(c.p.pnlWindow) ? (JSON.parse(readFileSync(c.p.pnlWindow, "utf8")) as { sessionEnd?: unknown }) : {}
    expect(window.sessionEnd).toBeUndefined()
    expect(rows(c, "client.attached").find((r) => r.clientName === "candle-harness ask")).toBeDefined()
  })
})

describe("candle-harness trigger <name>", () => {
  test("fires as its own condition would: its Activity line printed as it goes, and what it did waited for, exit 0", async () => {
    const { c } = await core({ inside: true })
    await save(c, `on call buy 0.01 sol of ${MOON} as "dip"`)
    const t = io()
    expect(await triggerCommand(["dip"], t.io, envOf(c))).toBe(EXIT.done)
    expect(trades(c)).toHaveLength(1)
    expect(t.text()).toStartWith("⚡ dip  someone called it from outside")
    expect(t.text().trimEnd().split("\n").at(-1)).toMatch(/^⚡ dip {2}someone called it from outside → filled BUY 0\.01 SOL of MOON from embedded in \d+\.\d s, without a card$/)
    expect(rows(c, "trigger.fired")[0]).toMatchObject({ name: "dip", cause: { by: "call" } })
    expect(rows(c, "client.attached").find((r) => r.clientName === "candle-harness trigger")).toBeDefined()
  })

  test("its cooldown: the second call is refused with when it can fire again, exit 5, and nothing is sent twice", async () => {
    const { c } = await core({ inside: true })
    await save(c, `on call buy 0.01 sol of ${MOON} as "dip"`)
    expect(await triggerCommand(["dip"], io().io, envOf(c))).toBe(EXIT.done)
    const t = io()
    expect(await triggerCommand(["dip"], t.io, envOf(c))).toBe(EXIT.cooldown)
    expect(t.errors()).toMatch(/^"dip" was last called at \d\d:\d\d, and its cooldown is 30 minutes: it can fire again at \d\d:\d\d\. Nothing was sent\.\n$/)
    expect(rows(c, "trigger.fired")).toHaveLength(1)
    expect(trades(c)).toHaveLength(1)
  })

  test("the kill switch: its buy is held and said, exit 1, nothing sent", async () => {
    const { c, view } = await core({ inside: true })
    await save(c, `on call buy 0.01 sol of ${MOON} as "dip"`)
    await view.request("kill", {})
    const t = io()
    expect(await triggerCommand(["dip"], t.io, envOf(c))).toBe(EXIT.failed)
    // One line, as it ended: a firing that settles in a moment isn't printed twice.
    expect(t.text()).toMatch(/^⚡ dip {2}someone called it from outside → .*Buying is paused by the kill switch.*0 of 1 sent.*\n$/)
    expect(rows(c, "trigger.held")[0]).toMatchObject({ name: "dip", reason: "paused" })
    expect(trades(c)).toHaveLength(0)
  })

  test("refused, nothing ran, exit 4: no such trigger, or one that fires on its own condition", async () => {
    const { c } = await core()
    await save(c, `when ${MOON} < $0.0001 sell 50% of ${MOON} as "stop"`)
    const unknown = io()
    expect(await triggerCommand(["dipp"], unknown.io, envOf(c))).toBe(EXIT.refused)
    expect(unknown.errors()).toStartWith('No trigger named "dipp".')
    const level = io()
    expect(await triggerCommand(["stop"], level.io, envOf(c))).toBe(EXIT.refused)
    expect(level.errors()).toBe('"stop" fires on its own condition. Only a trigger written on call is fired from outside. Nothing was sent.\n')
    expect(rows(c, "trigger.fired")).toHaveLength(0)
  })

  test("--no-wait returns once it fired; a name of several words is one name", async () => {
    const { c } = await core({ inside: true })
    await save(c, `on call notify "time to look" as "look now"`)
    const t = io()
    expect(await triggerCommand(["--no-wait", "look", "now"], t.io, envOf(c))).toBe(EXIT.done)
    expect(t.text()).toBe('"look now" fired. What it does shows in the Candle Harness\'s Activity.\n')
    await until(() => rows(c, "trigger.notify").length === 1)
  })
})

describe("candle-harness cards", () => {
  const proposing: Play = async (_turn, call) => {
    await call("candle_trade", { side: "buy", mint: MOON, amount: "0.01", reason: "asked" })
    return "Proposed."
  }

  test("no core running: says so, exit 3; an unknown option is usage", async () => {
    const { home } = await testHome()
    const t = io()
    expect(await cardsCommand([], t.io, { env: { ...process.env, CANDLE_HARNESS_HOME: home } })).toBe(EXIT.noCore)
    expect(t.errors()).toStartWith("No Candle Harness core is running")
    expect(await cardsCommand(["--approve"], io().io, { env: { ...process.env, CANDLE_HARNESS_HOME: home } })).toBe(EXIT.usage)
  })

  test("lists a waiting card, in words and as JSON, and changes nothing", async () => {
    const { c } = await core({ plays: [proposing] })
    const none = io()
    expect(await cardsCommand([], none.io, envOf(c))).toBe(EXIT.done)
    expect(none.text()).toStartWith("No cards")
    expect(await askCommand(["buy", "some", MOON], io().io, envOf(c))).toBe(EXIT.done)
    const card = c.core.cards.list()[0]!
    const words = io()
    expect(await cardsCommand([], words.io, envOf(c))).toBe(EXIT.done)
    expect(words.text()).toMatch(new RegExp(`^${card.cardId}  trade  momentum  .*MOON.*  ·  waiting for a press in the Candle Harness, until \\d\\d:\\d\\d:\\d\\d\\n$`))
    const json = io()
    expect(await cardsCommand(["--json", card.cardId], json.io, envOf(c))).toBe(EXIT.done)
    expect((JSON.parse(json.text()) as { cards: unknown[] }).cards).toEqual([expect.objectContaining({ cardId: card.cardId, state: "waiting", final: false, proposedBy: "momentum", mode: "live" })])
    expect(c.core.cards.get(card.cardId)!.state).toBe("awaiting_approval")
    expect(trades(c)).toHaveLength(0)
    const missing = io()
    expect(await cardsCommand(["card_nope"], missing.io, envOf(c))).toBe(EXIT.refused)
    expect(missing.errors()).toContain("No card with the id card_nope")
  })

  test("--wait returns once the person's press in the Candle Harness has run the card, and says how it ended", async () => {
    const { c, view } = await core({ plays: [proposing] })
    expect(await askCommand(["buy", "some", MOON], io().io, envOf(c))).toBe(EXIT.done)
    const card = c.core.cards.list()[0]!
    const t = io()
    let done = false
    const waiting = cardsCommand(["--wait", "--json", card.cardId], t.io, envOf(c)).then((code) => ((done = true), code))
    await Bun.sleep(150)
    expect(done).toBe(false)
    expect((await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })).error).toBeUndefined()
    expect(await waiting).toBe(EXIT.done)
    expect((JSON.parse(t.text()) as { cards: Record<string, unknown>[] }).cards).toEqual([expect.objectContaining({ cardId: card.cardId, state: "done", final: true, approved: "enter", ended: "done · approved by Enter" })])
    expect(trades(c)).toHaveLength(1)
  })

  test("--wait returns when the person rejects it; nothing was sent", async () => {
    const { c, view } = await core({ plays: [proposing] })
    expect(await askCommand(["buy", "some", MOON], io().io, envOf(c))).toBe(EXIT.done)
    const card = c.core.cards.list()[0]!
    const t = io()
    const waiting = cardsCommand(["--wait"], t.io, envOf(c))
    await Bun.sleep(100)
    await view.request("cards.reject", { cardId: card.cardId })
    expect(await waiting).toBe(EXIT.done)
    expect(t.text()).toContain("rejected by the person")
    expect(t.errors()).toContain("This only reads.")
    expect(trades(c)).toHaveLength(0)
  })

  test("it can never approve: it asks the core only to list, and the core refuses an approval from its client", async () => {
    const { c } = await core({ plays: [proposing] })
    expect(await askCommand(["buy", "some", MOON], io().io, envOf(c))).toBe(EXIT.done)
    const card = c.core.cards.list()[0]!
    // Everything the command file sends: the list, and the topic for --wait.
    const source = readFileSync(join(import.meta.dir, "cards.ts"), "utf8")
    expect([...source.matchAll(/\.request\("([^"]+)"/g)].map((m) => m[1]).sort()).toEqual(["cards.list", "subscribe"])
    const client = await c.view(CARDS_CLIENT)
    const tried = await client.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "enter" })
    expect(tried.error).toMatchObject({ data: { code: "MAIN_VIEW_ONLY" } })
    expect(c.core.cards.get(card.cardId)!.state).toBe("awaiting_approval")
    expect(trades(c)).toHaveLength(0)
    client.close()
  })

  test("each way a card can stand has its word", () => {
    const base = { cardId: "c1", opId: "o1", kind: "trade", agent: "momentum", tool: "candle_trade", display: { title: "BUY" } }
    const word = (extra: Record<string, unknown>) => [cardRow({ ...base, ...extra }).state, cardRow({ ...base, ...extra }).final]
    expect(word({ state: "awaiting_approval" })).toEqual(["waiting", false])
    expect(word({ state: "approved" })).toEqual(["running", false])
    expect(word({ state: "approved", operation: { state: "pending" } })).toEqual(["running", false])
    expect(word({ state: "approved", operation: { state: "succeeded" } })).toEqual(["done", true])
    expect(word({ state: "approved", operation: { state: "unknown" } })).toEqual(["unknown", false])
    expect(word({ state: "expired" })).toEqual(["expired", true])
    expect(word({ state: "withdrawn" })).toEqual(["withdrawn", true])
    expect(cardRow({ ...base, state: "approved", operation: { state: "failed", error: { code: "SLIPPAGE_EXCEEDED" } } })).toMatchObject({ state: "failed", code: "SLIPPAGE_EXCEEDED", ended: "failed: SLIPPAGE_EXCEEDED", final: true })
  })
})
