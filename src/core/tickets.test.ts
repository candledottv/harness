import { expect, test } from "bun:test"
import { PaneTickets, type PaneGrant, TICKET_TTL_MS } from "./tickets"

const grant: PaneGrant = { cardId: "card_1", opId: "op_1", title: "candle tee fund · the agent can't see this pane", bin: "/bin/candle", steps: [{ stage: "command", argv: ["tee", "fund", "X"] }], identity: "owner" }

function book(opts: { pidWaitMs?: number } = {}) {
  let now = 1_000_000
  const expired: string[] = []
  const tickets = new PaneTickets({ now: () => now, onExpired: (e) => expired.push(e.ticketId), pidWaitMs: opts.pidWaitMs ?? 50 })
  return { tickets, expired, advance: (ms: number) => (now += ms) }
}

const mint = (tickets: PaneTickets, viewClientId = "c_view") => tickets.mint({ cardId: "card_1", cardHash: "h", viewClientId, grant })

test("a ticket is chp_ plus a public id and a secret; the book keeps neither the secret nor the ticket", () => {
  const { tickets } = book()
  const { ticket, ticketId } = mint(tickets)
  expect(ticket).toMatch(/^chp_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{43}$/)
  expect(ticket.slice(4, 16)).toBe(ticketId)
  expect(JSON.stringify(tickets.get(ticketId))).not.toContain(ticket.slice(17))
})

test("it authenticates only from the pid the approving view named, and redeems once", async () => {
  const { tickets } = book()
  const { ticket, ticketId } = mint(tickets)
  tickets.spawned(ticketId, "c_view", 4242)
  expect(await tickets.authenticate(ticket, 4243)).toBeUndefined()
  expect(await tickets.authenticate(ticket, undefined)).toBeUndefined()
  const entry = await tickets.authenticate(ticket, 4242)
  expect(entry?.grant).toEqual(grant)
  tickets.redeem(ticketId)
  expect(() => tickets.redeem(ticketId)).toThrow(/already used/)
  expect(await tickets.authenticate(ticket, 4242)).toBeUndefined()
})

test("a hello that arrives before pane.spawned waits for it", async () => {
  const { tickets } = book({ pidWaitMs: 1000 })
  const { ticket, ticketId } = mint(tickets)
  const pending = tickets.authenticate(ticket, 777)
  setTimeout(() => tickets.spawned(ticketId, "c_view", 777), 20)
  expect((await pending)?.ticketId).toBe(ticketId)
})

test("with no pid named in time, the hello is refused", async () => {
  const { tickets } = book({ pidWaitMs: 20 })
  const { ticket } = mint(tickets)
  expect(await tickets.authenticate(ticket, 777)).toBeUndefined()
})

test("only the view that approved names the pid, once; another view learns nothing of the ticket", () => {
  const { tickets } = book()
  const { ticketId } = mint(tickets)
  expect(() => tickets.spawned(ticketId, "c_other", 10)).toThrow(/No open ticket/)
  expect(() => tickets.spawned(ticketId, "c_view", "10")).toThrow(/pid/)
  tickets.spawned(ticketId, "c_view", 10)
  expect(() => tickets.spawned(ticketId, "c_view", 11)).toThrow(/already named/)
})

test("a ticket with a wrong secret, a made-up id or the wrong shape is refused", async () => {
  const { tickets } = book()
  const { ticket, ticketId } = mint(tickets)
  tickets.spawned(ticketId, "c_view", 5)
  const wrong = `${ticket.slice(0, -1)}${ticket.endsWith("A") ? "B" : "A"}`
  expect(await tickets.authenticate(wrong, 5)).toBeUndefined()
  expect(await tickets.authenticate(`chp_${"Z".repeat(12)}_${"a".repeat(43)}`, 5)).toBeUndefined()
  expect(await tickets.authenticate("chv_view", 5)).toBeUndefined()
  expect(await tickets.authenticate(42, 5)).toBeUndefined()
})

test("a ticket lives 120 s: unredeemed, it expires and its card is told nothing ran", async () => {
  const { tickets, expired, advance } = book()
  const { ticket, ticketId } = mint(tickets)
  tickets.spawned(ticketId, "c_view", 5)
  advance(TICKET_TTL_MS)
  expect(await tickets.authenticate(ticket, 5)).toBeUndefined()
  expect(() => tickets.redeem(ticketId)).toThrow(/expired/)
  tickets.expireDue()
  expect(expired).toEqual([ticketId])
  expect(tickets.get(ticketId)).toBeUndefined()
})

test("a redeemed ticket is dropped later without being called expired", () => {
  const { tickets, expired, advance } = book()
  const { ticketId } = mint(tickets)
  tickets.redeem(ticketId)
  advance(TICKET_TTL_MS)
  tickets.expireDue()
  expect(expired).toEqual([])
})
