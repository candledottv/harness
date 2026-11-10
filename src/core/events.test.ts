// The event hub's sends can't hurt whoever calls them: a subscriber whose send throws loses that one message,
// and every other topic, subscriber and publisher carries on.
import { expect, test } from "bun:test"
import { EventHub, type Subscriber } from "./events"

type Sent = { topic: string; snapshot?: boolean }

function subscriber(clientId: string, throwOn?: string): { sub: Subscriber; sent: Sent[] } {
  const sent: Sent[] = []
  const sub: Subscriber = {
    clientId,
    role: "view",
    send: (n) => {
      if (n.params.topic === throwOn) throw new Error("too large")
      sent.push({ topic: String(n.params.topic), ...(n.params.snapshot ? { snapshot: true } : {}) })
    },
  }
  return { sub, sent }
}

test("a snapshot that can't be sent doesn't cost the topics after it theirs, and the subscription still counts", () => {
  const hub = new EventHub()
  for (const topic of ["status", "cards", "operations", "portfolio"]) hub.provideSnapshot(topic, () => ({ topic }))
  let changes = 0
  hub.onSubscriptionsChanged(() => changes++)
  const failures: string[] = []
  hub.onSendFailed((topic, sub) => failures.push(`${topic}:${sub.clientId}`))
  const { sub, sent } = subscriber("v1", "cards")
  expect(() => hub.subscribe(sub, ["status", "cards", "operations", "portfolio"])).not.toThrow()
  expect(sent).toEqual([{ topic: "status", snapshot: true }, { topic: "operations", snapshot: true }, { topic: "portfolio", snapshot: true }])
  expect(failures).toEqual(["cards:v1"])
  expect(changes).toBe(1)
  expect(hub.topicsOf("v1")).toEqual(["status", "cards", "operations", "portfolio"])
})

test("a snapshot provider that throws is one topic's loss too", () => {
  const hub = new EventHub()
  hub.provideSnapshot("cards", () => {
    throw new Error("provider failed")
  })
  hub.provideSnapshot("operations", () => [])
  const { sub, sent } = subscriber("v1")
  hub.subscribe(sub, ["cards", "operations"])
  expect(sent).toEqual([{ topic: "operations", snapshot: true }])
})

test("publishing never throws into the publisher, and the other subscribers still get the event", () => {
  const hub = new EventHub()
  const broken = subscriber("v1", "status")
  const fine = subscriber("v2")
  hub.subscribe(broken.sub, ["status"])
  hub.subscribe(fine.sub, ["status"])
  fine.sent.length = 0
  const failures: string[] = []
  hub.onSendFailed((topic, sub) => failures.push(`${topic}:${sub.clientId}`))
  expect(() => hub.publish("status", { paused: true })).not.toThrow()
  expect(fine.sent).toEqual([{ topic: "status" }])
  expect(failures).toEqual(["status:v1"])
})
