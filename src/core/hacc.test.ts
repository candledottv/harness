import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { type FakeHacc, startFakeHacc } from "../../test/fake-hacc"
import { DEFAULT_TIMEOUT_MS, HACC_CACHE_MAX, HACC_HOST, HaccClient, timeoutFor } from "./hacc"

// Built at run time: the scrub refuses key literals, even fake ones.
const keyA = ["cndl", "live", "a".repeat(32)].join("_")
const keyB = ["cndl", "live", "b".repeat(32)].join("_")
const revoked = ["cndl", "live", "r".repeat(32)].join("_")

let hacc: FakeHacc
let elsewhere: ReturnType<typeof Bun.serve>
const elsewhereHits: string[] = []
beforeAll(() => {
  hacc = startFakeHacc({ keys: [keyA, keyB] })
  elsewhere = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      elsewhereHits.push(req.headers.get("authorization") ?? "")
      return Response.json({ signals: [] })
    },
  })
})
afterAll(() => {
  hacc.stop()
  elsewhere.stop(true)
})
afterEach(() => {
  hacc.calls.length = 0
  hacc.set({ fail: {}, slow: {}, plan: "max" })
})

const keys: Record<string, string> = { "agent-a": keyA, "agent-b": keyB, "agent-r": revoked }
const client = (o: { accountOf?: (agent: string) => string | undefined; now?: () => number } = {}) =>
  new HaccClient({ keyFor: (a) => keys[a], host: hacc.url, now: o.now ?? (() => Date.now()), ...(o.accountOf ? { accountOf: o.accountOf } : {}) })
const everyKey = [keyA, keyB, revoked]
const showsAKey = (v: unknown) => everyKey.some((k) => JSON.stringify(v).includes(k))

test("the host is Hacc's own unless a test names the fake", () => {
  expect(HACC_HOST).toBe("https://api.hacc.fun")
  expect(timeoutFor("/v1/market/activity")).toBe(45_000)
  expect(timeoutFor("/v1/signals")).toBe(DEFAULT_TIMEOUT_MS)
})

test("the agent's own key goes as the bearer token, in the header only, and never comes back", async () => {
  const answer = await client().get("agent-b", "/v1/signals", { limit: 5 })
  expect(answer.kind).toBe("ok")
  expect(hacc.calls[0]!.auth).toBe(`Bearer ${keyB}`)
  expect(JSON.stringify(hacc.calls[0]!.query)).not.toContain(keyB)
  expect(showsAKey(answer)).toBe(false)
})

test("a redirect is refused, never followed, so the key reaches no other host", async () => {
  hacc.set({ fail: { "GET /v1/signals": { status: 302, headers: { location: `http://127.0.0.1:${elsewhere.port}/v1/signals` } } } })
  const answer = await client().get("agent-a", "/v1/signals")
  expect(answer).toMatchObject({ kind: "refused", code: "HACC_REDIRECT_REFUSED" })
  expect(elsewhereHits).toEqual([])
})

test("a route can't name another host", async () => {
  const answer = await client().get("agent-a", `http://127.0.0.1:${elsewhere.port}/v1/signals`)
  expect(answer).toMatchObject({ kind: "refused", code: "HACC_BAD_REQUEST" })
  expect(elsewhereHits).toEqual([])
})

describe("Hacc's refusals come back as codes with words", () => {
  test("a key Hacc doesn't take", async () => {
    const answer = await client().get("agent-r", "/v1/signals")
    expect(answer).toMatchObject({ kind: "refused", code: "HACC_KEY_REFUSED", status: 401 })
    if (answer.kind === "refused") expect(answer.message).toBe("Hacc refused agent-r's key (invalid api key). Hacc takes only a live, unrevoked production key (cndl_live_).")
    expect(showsAKey(answer)).toBe(false)
  })
  test("an agent with no key", async () => {
    expect(await client().get("nobody", "/v1/signals")).toMatchObject({ kind: "refused", code: "HACC_NO_KEY" })
  })
  test("a plan that doesn't reach the route", async () => {
    hacc.set({ plan: "free" })
    const pro = await client().get("agent-a", "/v1/me/follows")
    expect(pro).toMatchObject({ code: "PLAN_REQUIRED", plan: "pro" })
    if (pro.kind === "refused") expect(pro.message).toBe("This needs Candle's Pro or Max plan (Hacc: requires Pro or Max).")
    hacc.set({ plan: "pro" })
    expect(await client().get("agent-a", "/v1/strategy-lab/edges")).toMatchObject({ code: "PLAN_REQUIRED", plan: "max" })
  })
  test("a bad argument, in Hacc's own words, so the agent can fix it", async () => {
    const answer = await client().get("agent-a", "/v1/signals", { after: "116129029" })
    expect(answer).toMatchObject({ code: "HACC_BAD_REQUEST", message: "Hacc refused the request: after: Invalid date" })
  })
  test("a replay already running, with its job", async () => {
    const definition = { chain: "solana", entry: { source: "pattern", pattern: "confluence" }, exit: { stop_loss_pct: 40 }, sizing: { usd_per_trade: 25, max_concurrent: 4 } }
    const window = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString() }
    const first = await client().send("agent-a", "POST", "/v1/strategy-lab/replay", { definition, ...window })
    expect(first).toMatchObject({ kind: "ok", status: 202 })
    const busy = await client().send("agent-a", "POST", "/v1/strategy-lab/replay", { definition, ...window })
    expect(busy).toMatchObject({ code: "HACC_BUSY", jobId: (first as { body: { job_id: number } }).body.job_id })
  })
  test("a cap, with what's used", async () => {
    hacc.set({ fail: { "POST /v1/me/follows": { status: 429, body: { error: "follows cap reached", quota: 25, used: 25 } } } })
    const answer = await client().send("agent-a", "POST", "/v1/me/follows", { chain: "solana", address: "HaccFake11111111111111111111111111111111119" })
    expect(answer).toMatchObject({ code: "HACC_LIMIT", quota: 25, used: 25, message: "Hacc's limit: follows cap reached (25 of 25 used)." })
  })
  test("a cap named by limit, with when it frees up (book legs' snapshots, as Hacc answered them)", async () => {
    hacc.set({ fail: { "GET /v1/market/wallet/book-legs": { status: 429, body: { error: "snapshot_limit_reached", limit: 6, used: 6, retry_after_s: 1737 } } } })
    const answer = await client().get("agent-a", "/v1/market/wallet/HaccFake11111111111111111111111111111111119/book-legs", {})
    expect(answer).toMatchObject({ code: "HACC_LIMIT", quota: 6, used: 6, message: "Hacc's limit: snapshot_limit_reached (6 of 6 used); it frees up in about 29 min." })
  })
  test("Hacc's own failure says it's Hacc's", async () => {
    hacc.set({ fail: { "GET /v1/strategy-lab/runners": { status: 500, body: { error: "internal error" } } } })
    expect(await client().get("agent-a", "/v1/strategy-lab/runners", { hours: 24 })).toMatchObject({
      code: "HACC_FAILED",
      message: "Hacc failed (500: internal error). It's Hacc's error, not the request's.",
    })
  })
  test("no answer in time", async () => {
    hacc.set({ slow: { "GET /v1/signals": 300 } })
    const answer = await client().get("agent-a", "/v1/signals", {}, { timeoutMs: 100 })
    expect(answer).toMatchObject({ code: "HACC_NO_ANSWER" })
  })
  test("a key Hacc echoed back is redacted", async () => {
    hacc.set({ fail: { "GET /v1/signals": { status: 400, body: { error: `bad key ${keyA}` } } } })
    const answer = await client().get("agent-a", "/v1/signals")
    expect(showsAKey(answer)).toBe(false)
  })
})

describe("the cache", () => {
  const sameAccount = { accountOf: () => "account-1" }

  test("two agents on one account asking the same thing cost one call", async () => {
    const c = client(sameAccount)
    expect(await c.get("agent-a", "/v1/market/metas", {}, { cacheMs: 30_000 })).toMatchObject({ cached: false })
    expect(await c.get("agent-b", "/v1/market/metas", {}, { cacheMs: 30_000 })).toMatchObject({ cached: true })
    expect(hacc.calls).toHaveLength(1)
  })
  test("agents whose account isn't known don't share", async () => {
    const c = client()
    await c.get("agent-a", "/v1/market/metas", {}, { cacheMs: 30_000 })
    await c.get("agent-b", "/v1/market/metas", {}, { cacheMs: 30_000 })
    expect(hacc.calls).toHaveLength(2)
  })
  test("it ends when its time is up", async () => {
    let t = 0
    const c = client({ ...sameAccount, now: () => t })
    await c.get("agent-a", "/v1/market/metas", {}, { cacheMs: 1000 })
    t = 1500
    await c.get("agent-a", "/v1/market/metas", {}, { cacheMs: 1000 })
    expect(hacc.calls).toHaveLength(2)
  })
  test("a revoked key's agent is refused, and never served another agent's cached read", async () => {
    const c = client(sameAccount)
    await c.get("agent-a", "/v1/market/metas", {}, { cacheMs: 30_000 })
    expect((await c.get("agent-r", "/v1/signals")).kind).toBe("refused")
    expect(c.keyRefused("agent-r")).toContain("invalid api key")
    expect(await c.get("agent-r", "/v1/market/metas", {}, { cacheMs: 30_000 })).toMatchObject({ code: "HACC_KEY_REFUSED" })
    expect(await c.get("agent-b", "/v1/market/metas", {}, { cacheMs: 30_000 })).toMatchObject({ kind: "ok", cached: true })
  })
  test("answers past their time are dropped, not kept, as new ones come in", async () => {
    let t = 0
    const c = client({ ...sameAccount, now: () => t })
    for (const mint of ["MintA", "MintB", "MintC"]) await c.get("agent-a", "/v1/market/metas", { mint }, { cacheMs: 1000 })
    expect(c.cachedCount()).toBe(3)
    t = 1500
    await c.get("agent-a", "/v1/market/metas", { mint: "MintD" }, { cacheMs: 1000 })
    expect(c.cachedCount()).toBe(1)
  })
  test("however many distinct reads there are, it keeps a bounded number, the oldest going first", async () => {
    let t = 0
    const c = client({ ...sameAccount, now: () => t })
    for (let i = 0; i <= HACC_CACHE_MAX; i++) {
      t = i
      await c.get("agent-a", "/v1/market/metas", { mint: `Mint${i}` }, { cacheMs: 600_000 })
    }
    expect(c.cachedCount()).toBe(HACC_CACHE_MAX)
    const calls = hacc.calls.length
    expect(await c.get("agent-a", "/v1/market/metas", { mint: `Mint${HACC_CACHE_MAX}` }, { cacheMs: 600_000 })).toMatchObject({ cached: true })
    expect(await c.get("agent-a", "/v1/market/metas", { mint: "Mint0" }, { cacheMs: 600_000 })).toMatchObject({ cached: false })
    expect(hacc.calls.length).toBe(calls + 1)
  })
  test("a change clears the account's cached reads", async () => {
    const c = client(sameAccount)
    await c.get("agent-a", "/v1/me/follows", {}, { cacheMs: 30_000 })
    await c.send("agent-b", "POST", "/v1/me/follows", { chain: "solana", address: "HaccFake1111111111111111111111111111111111A" })
    const after = await c.get("agent-a", "/v1/me/follows", {}, { cacheMs: 30_000 })
    expect(after).toMatchObject({ cached: false })
    expect(JSON.stringify(after)).toContain("HaccFake1111111111111111111111111111111111A")
  })
})

test("the last refusal is kept for the topic, without a key, and cleared when that agent's key is taken again", async () => {
  const c = client()
  await c.get("agent-r", "/v1/signals")
  expect(c.lastRefusal).toMatchObject({ agent: "agent-r", code: "HACC_KEY_REFUSED" })
  expect(showsAKey(c.lastRefusal)).toBe(false)
  keys["agent-r"] = keyA
  await c.get("agent-r", "/v1/signals")
  expect(c.lastRefusal).toBeUndefined()
  expect(c.keyRefused("agent-r")).toBeUndefined()
  keys["agent-r"] = revoked
})

test("a refused key stays refused until the agent's key changes (its Hacc tools come back with a new key)", async () => {
  const held: Record<string, string> = { "agent-r": revoked }
  const c = new HaccClient({ keyFor: (a) => held[a], host: hacc.url, now: () => Date.now() })
  expect((await c.get("agent-r", "/v1/signals", { limit: 1 })).kind).toBe("refused")
  expect(c.keyRefused("agent-r")).toContain("invalid api key")
  held["agent-r"] = keyA
  expect(c.keyRefused("agent-r")).toBeUndefined()
  expect((await c.get("agent-r", "/v1/signals", { limit: 1 })).kind).toBe("ok")
  held["agent-r"] = revoked
  expect(c.keyRefused("agent-r")).toBeUndefined() // an answer cleared it: Hacc is asked again
})

test("each read Hacc answers is counted with its body's size, for the core's usage totals", async () => {
  const sizes: number[] = []
  const c = new HaccClient({ keyFor: (a) => keys[a], host: hacc.url, now: () => Date.now(), onRead: (bytes) => sizes.push(bytes) })
  const answer = await c.get("agent-a", "/v1/signals", { limit: 5 })
  expect(answer.kind).toBe("ok")
  expect(sizes).toHaveLength(1)
  expect(sizes[0]).toBeGreaterThan(0)
})
