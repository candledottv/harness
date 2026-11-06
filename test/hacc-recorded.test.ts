// The contract with Hacc, as recorded live, scrubbed into
// test/fixtures/hacc-recorded/. The fake Hacc answers every route the tools use with every field the
// real one put there, its refusals in Hacc's own words, and the stream's frames in their real shape.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { leftovers } from "../scripts/scrub-hacc"
import { type FakeHacc, startFakeHacc } from "./fake-hacc"

const dir = join(import.meta.dir, "fixtures/hacc-recorded")
// The Research and Signals reads.
const researchDir = join(dir, "research")
interface Recording {
  name: string
  method: string
  route: string
  query: Record<string, string>
  body?: unknown
  status: number | string
  answer: unknown
}
const all: Recording[] = readdirSync(dir)
  .filter((f) => f.endsWith(".json") && !f.startsWith("stream-"))
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))

/** Field names, one level into each row: what the core may rely on. */
function fields(v: unknown): string[] {
  if (Array.isArray(v)) return v.length ? fields(v[0]).map((f) => `[].${f}`) : []
  if (!v || typeof v !== "object") return []
  return Object.entries(v).flatMap(([k, x]) => [k, ...(Array.isArray(x) && x[0] && typeof x[0] === "object" ? Object.keys(x[0]).map((f) => `${k}[].${f}`) : [])])
}

const KEY = ["cndl", "live", "f".repeat(32)].join("_")
let hacc: FakeHacc
beforeAll(() => {
  hacc = startFakeHacc({ keys: [KEY] })
})
afterAll(() => hacc.stop())
const ask = (method: string, path: string, query: Record<string, string> = {}, body?: unknown) =>
  fetch(`${hacc.url}${path}?${new URLSearchParams(query)}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

test("nothing in the fixtures still looks like a real address, handle or link", () => {
  for (const d of [dir, researchDir]) for (const f of readdirSync(d).filter((f) => f.endsWith(".json"))) expect(leftovers(JSON.parse(readFileSync(join(d, f), "utf8")))).toEqual([])
})

describe("every recorded read the tools use answers from the fake with the real fields", () => {
  const reads = all.filter((r) => r.method === "GET" && r.status === 200 && !/^(change|after|strategy-wait|replay|changes|followup)-/.test(r.name))
  test.each(reads.map((r) => [r.name, r] as const))("%s", async (_name, r) => {
    const res = await ask("GET", r.route, r.query)
    expect(res.status).toBe(200)
    const got = fields(await res.json())
    for (const f of fields(r.answer)) expect(got).toContain(f)
  })
})

test("refusals answer in Hacc's recorded words", async () => {
  const unknown = await fetch(`${hacc.url}/v1/signals`, { headers: { authorization: `Bearer ${["cndl", "test", "0".repeat(32)].join("_")}` } })
  expect(unknown.status).toBe(401)
  expect(await unknown.json()).toEqual({ error: "invalid api key" })
  expect((await ask("GET", "/v1/signals", { limit: "500" })).status).toBe(400)
  expect(await (await ask("GET", "/v1/signals", { after: "116129029" })).json()).toEqual({ error: "after: Invalid date" })
  const history = all.find((r) => r.name === "token-history")!
  expect(await (await ask("GET", "/v1/market/token/short", {})).json()).toEqual(all.find((r) => r.name === "refused-bad-address")!.answer as object)
  expect((await ask("GET", history.route, { include_candles: "true" })).status).toBe(200)
})

test("follows, rules, groups and strategies keep state as Hacc does, and a second follow answers the first", async () => {
  const address = "HaccFake11111111111111111111111111111111119"
  const a = (await (await ask("POST", "/v1/me/follows", {}, { chain: "solana", address })).json()) as { follow: { id: number } }
  const b = (await (await ask("POST", "/v1/me/follows", {}, { chain: "solana", address })).json()) as { follow: { id: number } }
  expect(b.follow.id).toBe(a.follow.id)
  expect((await ask("POST", "/v1/me/rules", {}, { name: "x", pattern: "confluence", params: { wallets: 1 } })).status).toBe(400)
  const rule = (await (await ask("POST", "/v1/me/rules", {}, { name: "x", pattern: "large_move", params: { min_usd: 5000 } })).json()) as { rule: { id: number } }
  // Recorded: no route removes a rule; a DELETE is Fastify's "Route not found".
  const ruleDelete = all.find((r) => r.name === "change-rule-delete-large_move")!
  const gone = await ask("DELETE", `/v1/me/rules/${rule.rule.id}`)
  expect(gone.status).toBe(Number(ruleDelete.status))
  expect(((await gone.json()) as { error: string }).error).toBe((ruleDelete.answer as { error: string }).error)
  // Recorded: a version is a new id one version on, retired by PATCH; an unknown field is refused by name.
  const def = { chain: "solana", entry: { source: "pattern", pattern: "confluence" }, exit: { stop_loss_pct: 40 }, sizing: { usd_per_trade: 25, max_concurrent: 4 } }
  const saved = (await (await ask("POST", "/v1/strategies", {}, { name: "s", definition: def })).json()) as { strategy: { id: number; version: number } }
  const v2 = (await (await ask("POST", `/v1/strategies/${saved.strategy.id}/versions`, {}, { definition: def })).json()) as { strategy: { id: number; version: number; parent_version: number } }
  expect(v2.strategy.id).not.toBe(saved.strategy.id)
  expect([v2.strategy.version, v2.strategy.parent_version]).toEqual([2, 1])
  expect(((await (await ask("PATCH", `/v1/strategies/${v2.strategy.id}`, {}, { status: "retired" })).json()) as { strategy: { status: string } }).strategy.status).toBe("retired")
  expect(await (await ask("POST", "/v1/strategies", {}, { name: "s", definition: { ...def, extra: true } })).json()).toEqual(all.find((r) => r.name === "change-strategy-save-bad")!.answer as object)
  expect((await ask("DELETE", `/v1/me/follows/${a.follow.id}`)).status).toBe(204)
  hacc.set({ plan: "free" })
  expect(await (await ask("GET", "/v1/me/follows")).json()).toEqual({ error: "requires Pro or Max" })
  hacc.set({ plan: "max" })
})

test("a replay runs one at a time per key, then answers done", async () => {
  const definition = { chain: "solana", entry: { source: "pattern", pattern: "confluence" }, exit: { stop_loss_pct: 40 }, sizing: { usd_per_trade: 25, max_concurrent: 4 } }
  const window = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString() }
  const { job_id } = (await (await ask("POST", "/v1/strategy-lab/replay", {}, { definition, ...window })).json()) as { job_id: number }
  const busy = await ask("POST", "/v1/strategy-lab/replay", {}, { definition, ...window })
  expect(busy.status).toBe(409)
  expect(((await busy.json()) as { code: string }).code).toBe("lab_active")
  let status = ""
  for (let i = 0; i < 5 && status !== "done"; i++) status = ((await (await ask("GET", `/v1/strategy-lab/replay/${job_id}`)).json()) as { status: string }).status
  expect(status).toBe("done")
})

test("the stream sends the snapshot, then each new signal, in the recorded frames", async () => {
  const stream = JSON.parse(readFileSync(join(dir, "stream-main.json"), "utf8")) as { frames: { frame: unknown }[] }
  const ws = new WebSocket(`${hacc.wsUrl}/v1/signals/stream`, { headers: { authorization: `Bearer ${KEY}` } } as unknown as string[])
  const frames: unknown[] = []
  await new Promise<void>((done) => {
    ws.onmessage = (e) => {
      frames.push(JSON.parse(String(e.data)))
      if (frames.length === 1) hacc.push()
      if (frames.length === 2) done()
    }
  })
  ws.close()
  for (const f of fields(stream.frames[0]!.frame)) expect(fields(frames[0])).toContain(f)
  for (const f of fields(stream.frames[1]!.frame)) expect(fields(frames[1])).toContain(f)
})

describe("Research's token reads and the tape by token and pattern", () => {
  const research = (name: string): Recording => JSON.parse(readFileSync(join(researchDir, `${name}.json`), "utf8"))
  const rowsOf = async (query: Record<string, string>) => ((await (await ask("GET", "/v1/signals", query)).json()) as { signals: Record<string, unknown>[] }).signals

  test.each(["top-traders", "profile", "launch-overview", "market", "mentions"].flatMap((v) => ["jup", "young"].map((t) => `research-${t}-${v}`)))("%s answers from the fake with the real fields", async (name) => {
    const r = research(name)
    const res = await ask("GET", r.route, r.query)
    expect(res.status).toBe(200)
    const got = fields(await res.json())
    for (const f of fields(r.answer)) expect(got).toContain(f)
  })

  test("one token's signals: the tape by its mint or its asset id holds that token only, in the tape's fields", async () => {
    const real = research("research-jup-signals-asset").answer as { signals: Record<string, unknown>[] }
    expect(new Set(real.signals.map((s) => s.asset_address)).size).toBe(1)
    const [row] = await rowsOf({ limit: "1" })
    const byMint = await rowsOf({ asset: String(row!.asset_address), limit: "20" })
    expect(byMint.length).toBeGreaterThan(0)
    expect(byMint.every((s) => s.asset_address === row!.asset_address)).toBe(true)
    for (const f of Object.keys(real.signals[0]!)) expect(Object.keys(byMint[0]!)).toContain(f)
    expect((await rowsOf({ asset: String(row!.asset_id), limit: "5" })).length).toBeGreaterThan(0)
    expect(await rowsOf({ asset: "HaccFake11111111111111111111111111111111119", limit: "5" })).toEqual([])
  })

  test("each pattern filters the tape to that pattern, as recorded", async () => {
    for (const pattern of ["confluence", "deployer", "large_move", "dormancy", "intra_book", "new_ticker", "distribution", "kol_mention"]) {
      const real = (research(`research-pattern-${pattern}`).answer as { signals: { pattern: string }[] }).signals
      expect(real.every((s) => s.pattern === pattern)).toBe(true)
      const got = await rowsOf({ pattern, limit: "50" })
      expect(got.length).toBeGreaterThan(0)
      expect(got.every((s) => s.pattern === pattern)).toBe(true)
    }
    expect((await rowsOf({ pattern: "new_ticker", chain: "hood", limit: "50" })).every((s) => s.asset_chain === "hood")).toBe(true)
  })
})
