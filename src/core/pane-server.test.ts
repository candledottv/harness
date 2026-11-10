// The pane role over the socket, with this test process as the launcher: the view
// names this process's pid, so the hello's peer pid matches.
import { afterAll, afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { AGENT_KEY, cleanupHomes, fakeCandle, startTestCore, type TestCore, until } from "../../test/core-fixture"
import type { TestClient } from "../../test/core-test-client"
import { PROTOCOL_VERSION } from "../shared/rpc"
import { TICKET_TTL_MS } from "./tickets"

const TEE = "TeeFake111111111111111111111111111111111111"
const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close()
})
afterAll(() => cleanupHomes())

async function setup(opts: Parameters<typeof startTestCore>[0] = {}) {
  const c = await startTestCore(opts)
  cores.push(c)
  const view = await c.view()
  return { c, view }
}

/** A typed `tee fund`, opened, and this process named as its pane. */
async function paneHere(c: TestCore, view: TestClient): Promise<{ pane: TestClient; ticket: string; ticketId: string; opId: string; hello: unknown }> {
  const r = (await view.request("cli.run", { argv: ["tee", "fund", TEE, "--amount", "0.001"] })).result as { ticket: string; ticketId: string; card: { opId: string } }
  await view.request("pane.spawned", { ticketId: r.ticketId, pid: process.pid })
  const { client, response } = await c.hello(r.ticket)
  return { pane: client, ticket: r.ticket, ticketId: r.ticketId, opId: r.card.opId, hello: response.result }
}

test("a pane's hello says only the protocol and its role; it may call only pane.redeem and pane.report", async () => {
  const { c, view } = await setup()
  const { pane, hello } = await paneHere(c, view)
  expect(hello).toEqual({ protocol: PROTOCOL_VERSION, coreVersion: expect.any(String), clientId: expect.any(String), role: "pane" })
  for (const method of ["core.status", "cards.list", "cards.approve", "tools.call", "subscribe", "cli.run", "pane.spawned", "harness.register"]) {
    expect(`${method}: ${(await pane.request(method, {})).error?.data?.code}`).toBe(`${method}: FORBIDDEN_FOR_ROLE`)
  }
})

test("report before redeem is refused; redeem answers what the card runs, once; the report settles it and ends the connection", async () => {
  const { c, view } = await setup()
  const { pane, opId } = await paneHere(c, view)
  expect((await pane.request("pane.report", { stage: "command", exit: 0 })).error?.data?.code).toBe("NOT_REDEEMED")
  const redeemed = (await pane.request("pane.redeem")).result as Record<string, unknown>
  expect(redeemed).toMatchObject({ title: `candle tee fund ${TEE} --amount 0.001 · the agent can't see this pane`, identity: "owner", steps: [{ stage: "command", argv: ["tee", "fund", TEE, "--amount", "0.001"] }] })
  expect(redeemed.apiKey).toBeUndefined()
  expect((await pane.request("pane.redeem")).error?.data?.code).toBe("TICKET_SPENT")
  for (const bad of [{}, { stage: "elsewhere" }, { stage: "command", exit: -1 }, { stage: "command", exit: 1.5 }, { stage: "command", signal: "kill -9" }, { stage: "factor", code: "lower" }, { stage: "command", stopped: "yes" }]) {
    expect((await pane.request("pane.report", bad)).error?.data?.code).toBe("INVALID_PARAMS")
  }
  expect((await pane.request("pane.report", { stage: "command", exit: 0 })).result).toEqual({ outcome: "finished", words: "finished in the pane." })
  await pane.closed
  expect(c.core.operations.get(opId)!.state).toBe("succeeded")
  // The journal names the ticket by id only.
  expect(c.core.journal.rows().filter((r) => r.type.startsWith("pane.")).map((r) => r.type)).toEqual(["pane.spawned", "pane.redeemed"])
})

test("a keyed RPC address reaches the pane's command as configured, and no view or journal", async () => {
  const rpcUrl = `https://rpc.example/?api-key=${"k".repeat(12)}-${Date.now()}`
  const c = await startTestCore({}, { config: { candle: { mcp: { route: "cli", path: "candle-mcp" }, cliPath: await fakeCandle(), rpcUrl, profile: undefined } } })
  cores.push(c)
  const view = await c.view()
  const r = (await view.request("cli.run", { argv: ["vault", "list"] })).result as { ticket: string; ticketId: string }
  await view.request("pane.spawned", { ticketId: r.ticketId, pid: process.pid })
  const { client: pane } = await c.hello(r.ticket)
  const redeemed = (await pane.request("pane.redeem")).result as { steps: { argv: string[] }[] }
  expect(redeemed.steps.at(-1)!.argv).toEqual(["vault", "list", "--json", "--rpc-url", rpcUrl])
  for (const frame of view.frames) expect(frame).not.toContain(rpcUrl)
  expect(JSON.stringify(c.core.journal.rows())).not.toContain(rpcUrl)
})

test("an RPC address keyed in its path reaches the pane alone: no view, no harness and no journal row holds it, and the card names it by a marker", async () => {
  const rpcUrl = `https://rpc.example/v2/${"p".repeat(24)}${Date.now()}`
  const c = await startTestCore({}, { config: { candle: { mcp: { route: "cli", path: "candle-mcp" }, cliPath: await fakeCandle(), rpcUrl, profile: undefined } } })
  cores.push(c)
  const view = await c.view()
  await view.request("subscribe", { topics: ["cards", "operations", "activity"] })
  const r = (await view.request("cli.run", { argv: ["vault", "list"] })).result as { ticket: string; ticketId: string }
  await view.request("pane.spawned", { ticketId: r.ticketId, pid: process.pid })
  const { client: pane } = await c.hello(r.ticket)
  const redeemed = (await pane.request("pane.redeem")).result as { steps: { argv: string[] }[] }
  expect(redeemed.steps.at(-1)!.argv).toEqual(["vault", "list", "--json", "--rpc-url", rpcUrl])
  const cards = (await view.request("cards.list")).result as { cards: { params: unknown }[] }
  expect(JSON.stringify(cards)).toContain('"--rpc-url","@config"')
  await view.request("operations.list")
  for (const frame of view.frames) expect(frame).not.toContain(rpcUrl)
  expect(JSON.stringify(c.core.journal.rows())).not.toContain(rpcUrl)
  expect(readFileSync(c.p.journal, "utf8")).not.toContain(rpcUrl)
})

test("an agent's row: its key goes once, to the pane, and to no view", async () => {
  const { c, view } = await setup()
  const { client: harness } = await c.harness(view)
  const asked = await harness.request("tools.call", { name: "candle_cli", args: { command: "tee", subcommand: "disable", args: [TEE] } })
  const card = c.core.cards.get(JSON.parse((asked.result as { content: { text: string }[] }).content[0]!.text).cardId)!
  const approved = (await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash })).result as { ticket: string; ticketId: string }
  await view.request("pane.spawned", { ticketId: approved.ticketId, pid: process.pid })
  const { client: pane } = await c.hello(approved.ticket)
  const redeemed = (await pane.request("pane.redeem")).result as Record<string, unknown>
  expect(redeemed).toMatchObject({ identity: "agent", agent: "momentum", apiKey: AGENT_KEY })
  expect(pane.frames.filter((f) => f.includes(AGENT_KEY))).toHaveLength(1)
  for (const frame of [...view.frames, ...harness.frames]) expect(frame).not.toContain(AGENT_KEY)
  expect(JSON.stringify(c.core.journal.rows())).not.toContain(AGENT_KEY)
})

test("a pane that goes before reporting leaves the step unknown, never re-run", async () => {
  const { c, view } = await setup()
  const { pane, opId } = await paneHere(c, view)
  await pane.request("pane.redeem")
  pane.close()
  await until(() => c.core.operations.get(opId)!.state !== "pending")
  expect(c.core.operations.get(opId)!.state).toBe("unknown")
  expect((await view.request("operations.resolve", { opId, action: "resend" })).error?.data?.code).toBe("NO_RESEND")
  expect((await view.request("operations.resolve", { opId, action: "abandon" })).result).toMatchObject({ state: "abandoned" })
})

test("a ticket nobody redeems in 120 s expires: the step is refused, and nothing ran", async () => {
  let now = Date.now()
  const { c, view } = await setup({ now: () => now })
  const r = (await view.request("cli.run", { argv: ["tee", "fund", TEE, "--amount", "0.001"] })).result as { ticket: string; ticketId: string; card: { opId: string } }
  now += TICKET_TTL_MS
  await until(() => c.core.operations.get(r.card.opId)!.state !== "pending", 3000)
  expect(c.core.operations.get(r.card.opId)).toMatchObject({ state: "refused", error: { code: "PANE_NOT_OPENED" } })
  await view.request("pane.spawned", { ticketId: r.ticketId, pid: process.pid }).then((a) => expect(a.error?.data?.code).toBe("TICKET_NOT_FOUND"))
  const { response } = await c.hello(r.ticket)
  expect(response.error?.data?.code).toBe("UNAUTHENTICATED")
})

test("a view may not claim an approval as typed or instant", async () => {
  const { c, view } = await setup()
  const { client: harness } = await c.harness(view)
  const asked = await harness.request("tools.call", { name: "candle_cli", args: { command: "tee", subcommand: "disable", args: [TEE] } })
  const card = c.core.cards.get(JSON.parse((asked.result as { content: { text: string }[] }).content[0]!.text).cardId)!
  await view.request("cards.approve", { cardId: card.cardId, cardHash: card.cardHash, how: "typed" })
  expect(c.core.cards.get(card.cardId)!.approvedHow).toBe("view")
})
