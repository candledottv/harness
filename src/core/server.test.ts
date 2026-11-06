// The attach protocol, 2.0: roles, no secret over the socket, and a card that needs no view. Run against
// a whole core, over its real socket, with the fake Candle server behind it. A harness can't act as a view.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { readFileSync, statSync } from "node:fs"
import { AGENT_KEY, cleanupHomes, startTestCore, type TestCore, until } from "../../test/core-fixture"
import { PROTOCOL_VERSION } from "../shared/rpc"
import { readViewToken } from "./tokens"
import { METHOD_ROLES } from "./server"

const MOON = "MoonFake11111111111111111111111111111111111"
const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
})
afterAll(cleanupHomes)

async function core() {
  const c = await startTestCore()
  cores.push(c)
  return c
}

describe("core.hello", () => {
  test("a view reads view.token, attaches, and the token rotates; the next view reads the new one", async () => {
    const c = await core()
    const first = await readViewToken(c.p.viewToken)
    const { response } = await c.hello(first!)
    expect(response.result).toMatchObject({ protocol: PROTOCOL_VERSION, role: "view", activeAgent: "momentum", mode: "live", paused: false, agents: ["momentum", "swing"] })
    expect((response.result as { account: string }).account).toMatch(/^acct_/)
    const second = await readViewToken(c.p.viewToken)
    expect(second).not.toBe(first)
    expect(statSync(c.p.viewToken).mode & 0o777).toBe(0o600)
    await c.view()
    expect(c.core.server.viewCount()).toBe(2)
  })

  test("a replaced view token is no longer redacted, so the redactor holds only the live one however often views attach", async () => {
    const c = await core()
    const replaced: string[] = []
    for (let i = 0; i < 3; i++) {
      replaced.push((await readViewToken(c.p.viewToken))!)
      await c.view()
    }
    const live = (await readViewToken(c.p.viewToken))!
    await c.core.journal.append({ type: "probe", mode: "live", replaced, live })
    const journal = readFileSync(c.p.journal, "utf8")
    for (const token of replaced) expect(journal).toContain(token)
    expect(journal).not.toContain(live)
  })

  test("a replayed view token is refused, and the connection closes", async () => {
    const c = await core()
    const token = (await readViewToken(c.p.viewToken))!
    await c.hello(token)
    const replay = await c.hello(token)
    expect(replay.response.error?.data?.code).toBe("UNAUTHENTICATED")
    await replay.client.closed
  })

  test("no token, or any method before hello, is UNAUTHENTICATED and closes", async () => {
    const c = await core()
    const none = await c.hello(undefined as never)
    expect(none.response.error?.data?.code).toBe("UNAUTHENTICATED")
    await none.client.closed
    const early = await c.connect()
    expect((await early.request("core.status")).error?.data?.code).toBe("UNAUTHENTICATED")
    await early.closed
  })

  test("a different protocol major is refused with both versions", async () => {
    const c = await core()
    const { client, response } = await c.hello((await readViewToken(c.p.viewToken))!, { protocol: "1.0" })
    expect(response.error?.data).toEqual({ code: "PROTOCOL_MISMATCH", core: PROTOCOL_VERSION, client: "1.0" })
    await client.closed
  })

  test("the socket is mode 0600", async () => {
    const c = await core()
    expect(statSync(c.p.socket).mode & 0o777).toBe(0o600)
  })
})

describe("roles", () => {
  test("for every method, a harness and a view are each refused exactly where the table says no", async () => {
    const c = await core()
    const viewClient = await c.view()
    const { client: harnessClient } = await c.harness(viewClient)
    const forbidden: string[] = []
    for (const [method, roles] of Object.entries(METHOD_ROLES)) {
      if (method === "core.hello") continue
      const answer = await harnessClient.request(method, {})
      const refused = answer.error?.data?.code === "FORBIDDEN_FOR_ROLE"
      expect(`${method}: ${refused}`).toBe(`${method}: ${roles.harness === "no"}`)
      if (refused) {
        expect(answer.error?.code).toBe(-32001)
        forbidden.push(method)
      }
      const viewAnswer = await viewClient.request(method, {})
      expect(`${method}: ${viewAnswer.error?.data?.code === "FORBIDDEN_FOR_ROLE"}`).toBe(`${method}: ${roles.view === "no"}`)
    }
    // A view is refused only the pane's own two methods.
    expect(Object.entries(METHOD_ROLES).filter(([, r]) => r.view === "no").map(([m]) => m).sort()).toEqual(["pane.redeem", "pane.report"])
    expect(forbidden.sort()).toEqual(Object.entries(METHOD_ROLES).filter(([, r]) => r.harness === "no").map(([m]) => m).sort())
    expect(forbidden).toContain("cards.approve")
    expect(forbidden).toContain("cli.run")
    // Each refusal is journalled.
    expect(c.core.journal.rows().filter((r) => r.type === "call.forbidden" && r.role === "harness").map((r) => r.method).sort()).toEqual(forbidden.sort())
  })

  test("a harness approving a card is refused, and the card stays open", async () => {
    const c = await core()
    const viewClient = await c.view()
    const { client: harnessClient } = await c.harness(viewClient)
    const proposed = await harnessClient.request("tools.call", { name: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.01" } })
    const body = JSON.parse((proposed.result as { content: { text: string }[] }).content[0]!.text)
    expect(body.error.code).toBe("APPROVAL_REQUIRED")
    const card = c.core.cards.get(body.cardId)!
    expect((await harnessClient.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })).error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")
    expect(c.core.cards.get(body.cardId)!.state).toBe("awaiting_approval")
  })

  test("a method not in the table doesn't exist", async () => {
    const c = await core()
    const viewClient = await c.view()
    expect((await viewClient.request("cards.approveAll")).error).toMatchObject({ code: -32601, data: { code: "METHOD_NOT_FOUND" } })
    expect((await viewClient.request("toString")).error?.data?.code).toBe("METHOD_NOT_FOUND")
  })

  test("a harness may not subscribe to agent, activity, or every agent's status and plan; it may to its cards", async () => {
    const c = await core()
    const { client } = await c.harness()
    for (const topic of ["agent", "activity", "status", "hacc"]) expect((await client.request("subscribe", { topics: [topic] })).error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")
    expect((await client.request("core.status", {})).error?.data?.code).toBe("FORBIDDEN_FOR_ROLE")
    expect((await client.request("subscribe", { topics: ["cards", "operations"] })).result).toEqual({ topics: ["cards", "operations"] })
    expect((await client.request("subscribe", { topics: ["nonsense"] })).error?.data?.code).toBe("INVALID_PARAMS")
  })
})

describe("a card needs no view", () => {
  test("with every view gone, a harness's live trade still becomes a card", async () => {
    const c = await core()
    const { client: harnessClient, registrar } = await c.harness()
    registrar.close()
    await until(() => c.core.server.viewCount() === 0)
    const answer = await harnessClient.request("tools.call", { name: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.01" } })
    expect(JSON.parse((answer.result as { content: { text: string }[] }).content[0]!.text).error.code).toBe("APPROVAL_REQUIRED")
  })
})

describe("no secret over the socket", () => {
  test("no frame from either role carries an agent key or a view token; a harness token goes once, to the view that asked", async () => {
    const c = await core()
    // A handler that tries to leak, as an upstream error with a key in it would.
    c.core.server.handle("core.status", async () => {
      throw new Error(`upstream 500 for ${AGENT_KEY}`)
    })
    const viewTokens: string[] = []
    const viewClient = await (async () => {
      viewTokens.push((await readViewToken(c.p.viewToken))!)
      return c.view()
    })()
    viewTokens.push((await readViewToken(c.p.viewToken))!)
    const { client: harnessClient, token } = await c.harness(viewClient)
    viewTokens.push((await readViewToken(c.p.viewToken))!)
    await viewClient.request("subscribe", { topics: ["status", "cards", "operations", "market"] })
    await harnessClient.request("subscribe", { topics: ["cards"] })
    for (const method of Object.keys(METHOD_ROLES)) {
      if (method === "core.hello") continue
      await viewClient.request(method, { topics: ["status"], name: "probe" })
      await harnessClient.request(method, { topics: ["status"] })
    }
    await harnessClient.request("tools.call", { name: "candle_get_wallets", args: {} })
    await harnessClient.request("tools.call", { name: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.01" } })
    await until(() => viewClient.events.some((e) => e.topic === "cards" && !e.snapshot))
    const frames = [...viewClient.frames, ...harnessClient.frames]
    expect(frames.length).toBeGreaterThan(40)
    for (const secret of [AGENT_KEY, ...viewTokens]) expect(frames.filter((f) => f.includes(secret))).toEqual([])
    const carrying = frames.filter((f) => f.includes(token))
    expect(carrying).toHaveLength(1)
    expect(viewClient.frames).toContain(carrying[0]!)
    // The token book on disk holds hashes only.
    expect(readFileSync(c.p.tokens, "utf8")).not.toContain(token)
    expect(statSync(c.p.tokens).mode & 0o777).toBe(0o600)
  })
})

describe("the trade, end to end", () => {
  test("a harness proposes, the view sees the card, approves it with one press, and sees the operation settle", async () => {
    const c = await core()
    const viewClient = await c.view()
    const { client: harnessClient } = await c.harness(viewClient)
    await viewClient.request("subscribe", { topics: ["cards", "operations"] })
    const answer = await harnessClient.request("tools.call", { name: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.01" }, reason: "breakout" })
    const { cardId } = JSON.parse((answer.result as { content: { text: string }[] }).content[0]!.text)
    await until(() => viewClient.events.some((e) => e.topic === "cards" && (e.data as { cardId?: string })?.cardId === cardId))
    const card = viewClient.events.find((e) => e.topic === "cards" && (e.data as { cardId?: string })?.cardId === cardId)!.data as { cardHash: string; display: { title: string; why: string } }
    expect(card.display).toMatchObject({ title: "BUY 0.01 SOL (≈$1.50) → MOON", why: "breakout" })
    const approved = await viewClient.request("cards.approve", { cardId, cardHash: card.cardHash })
    expect(approved.result).toMatchObject({ kind: "submitted", operation: { state: "succeeded" } })
    await until(() => viewClient.events.some((e) => e.topic === "operations" && (e.data as { state?: string }).state === "succeeded"))
    // The harness reads the outcome back by its card.
    const read = await harnessClient.request("tools.call", { name: "candle_get_operation", args: { clientId: (approved.result as { card: { opId: string } }).card.opId, kind: "trade" } })
    expect(JSON.parse((read.result as { content: { text: string }[] }).content[0]!.text)).toMatchObject({ success: true, state: "succeeded" })
  })

  test("a harness sees only its own cards", async () => {
    const c = await core()
    const viewClient = await c.view()
    const a = await c.harness(viewClient)
    const b = await c.harness(viewClient)
    await a.client.request("tools.call", { name: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.01" } })
    expect(((await a.client.request("cards.list")).result as { cards: unknown[] }).cards).toHaveLength(1)
    expect(((await b.client.request("cards.list")).result as { cards: unknown[] }).cards).toHaveLength(0)
    expect(((await viewClient.request("cards.list")).result as { cards: unknown[] }).cards).toHaveLength(1)
  })

  test("a harness acts as the agent its turn was started for", async () => {
    const c = await core()
    const viewClient = await c.view()
    const { client } = await c.harness(viewClient, "swing")
    await client.request("tools.call", { name: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.01" } })
    expect(c.core.cards.list()[0]!.agent).toBe("swing")
  })
})
