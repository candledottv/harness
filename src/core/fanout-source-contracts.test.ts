// The multi-RPC send (BE-3925), as Candle's API runs it: which extra endpoints a send is copied to, copies that leave
// only after the primary took a send made with preflight, a resend that goes everywhere at once, the primary's own
// answer unchanged, and one sendTransaction only. Recorded offline from one exact commit (scripts/read-fanout-source.ts).
// The commit is a staging build that changes no CLI, MCP or SDK file; the web side is pinned as source text.
import { expect, test } from "bun:test"
import fanout from "../../test/fixtures/candle-fanout-source.json"

type Call = { n: number; host: string; method: string; skipPreflight?: boolean; maxRetries?: number; minContextSlot: boolean; sameBytes: boolean; encoding?: string }
type Row = { id: string; scenario: string; args: Record<string, unknown>; calls?: Call[]; outcome: Record<string, any> }
const rows = fanout.rows as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing recording ${id}`)
  return found
}
const scenario = (name: string) => rows.filter((r) => r.scenario === name)
const hosts = (r: Row) => (r.calls ?? []).map((c) => c.host)
// Every failure class a copy can report: a status, a JSON-RPC code, or one word. Never an endpoint or an error text.
const MAPPED_REASON = /^(http \d{3}|rpc -?\d+|rpc error|timeout|network)$/

test("the recording names the exact staging build, the files, and that no CLI, MCP or SDK file moved", () => {
  expect(fanout.source).toMatchObject({
    repo: "candledottv/candle-monorepo",
    commit: "be55c5f9021c4059cbf4ce51b15fa83746a62525",
    versions: { cli: "0.13.31", mcp: "0.10.36", sdk: "0.6.25" },
    files: [
      "apps/api/src/services/solana/send-fanout.ts",
      "apps/api/src/routes/rpc.ts",
      "apps/frontend/src/hooks/tokens/swap-send.ts",
      "apps/frontend/src/components/trade/quick-buy-button.tsx",
      "apps/frontend/src/components/trade/roster-board.tsx",
    ],
  })
  expect(rows).toHaveLength(40)
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  expect(new Set(rows.map((r) => r.scenario))).toEqual(new Set(["endpoints", "preflight", "resend", "copy-failure", "shape", "source-pin"]))
})

test("nothing in the recording is a key, a signature or the bytes of a transaction, and every host is made up", () => {
  const text = JSON.stringify(fanout)
  for (const secret of ["fixture-only-not-a-key", "api-key", "BEGIN", "AQIDBAUG", "5VERv8NM"]) expect(text).not.toContain(secret)
  const seen = new Set(rows.flatMap((r) => [...hosts(r), ...((r.outcome.hosts as string[] | undefined) ?? [])]))
  for (const host of seen) expect(host === "api.mainnet-beta.solana.com" || host.endsWith(".test"), host).toBe(true)
  // Solana's public endpoint is only ever named as the default of a deployed instance; no send is recorded to it.
  expect(rows.filter((r) => hosts(r).includes("api.mainnet-beta.solana.com"))).toEqual([])
  expect(rows.filter((r) => r.outcome.hosts?.includes("api.mainnet-beta.solana.com")).map((r) => r.id)).toEqual(["endpoints-unset-deployed", "endpoints-unset-production-build"])
})

test("a deployed instance with nothing set copies to Solana's public endpoint, a local one to none, and blank turns it off", () => {
  expect(row("endpoints-unset-deployed").outcome.hosts).toEqual(["api.mainnet-beta.solana.com"])
  expect(row("endpoints-unset-production-build").outcome.hosts).toEqual(["api.mainnet-beta.solana.com"])
  for (const id of ["endpoints-unset-local", "endpoints-blank-deployed", "endpoints-blank-local"]) expect(row(id).outcome.hosts, id).toEqual([])
})

test("a bad entry narrows the list and never widens it, and the list stops at four", () => {
  expect(row("endpoints-two-listed").outcome.hosts).toEqual(["extra-a.test", "extra-b.test"])
  for (const id of ["not-https-dropped", "userinfo-dropped", "repeat-and-primary-dropped"]) expect(row(`endpoints-${id}`).outcome.hosts, id).toEqual(["extra-a.test"])
  expect(row("endpoints-capped-at-four").outcome.hosts).toEqual(["extra-1.test", "extra-2.test", "extra-3.test", "extra-4.test"])
})

test("a send with preflight goes to the primary first and the same bytes follow to each copy, never simulated again", () => {
  const r = row("preflight-accepted-copies-follow")
  expect(hosts(r)).toEqual(["primary.test", "extra-a.test", "extra-b.test"])
  expect(r.calls!.every((c) => c.sameBytes && c.method === "sendTransaction")).toBe(true)
  expect(r.calls![0]).toMatchObject({ skipPreflight: false, minContextSlot: true })
  for (const copy of r.calls!.slice(1)) expect(copy).toMatchObject({ skipPreflight: true, maxRetries: 5, minContextSlot: false, encoding: "base64" })
  expect(r.outcome).toMatchObject({ answerStatus: 200, primaryFirst: true, copiesAfterAnswer: true, answerIsPrimarys: true })
})

test("a refused send, an error, an unreadable answer or no answer from the primary sends no copy, so a refusal still means nothing was sent", () => {
  for (const id of ["preflight-refused-no-copy", "preflight-primary-429-no-copy", "preflight-primary-500-no-copy", "preflight-primary-not-json-no-copy", "preflight-primary-empty-result-no-copy"]) {
    expect(hosts(row(id)), id).toEqual(["primary.test"])
    expect(row(id).outcome.copiesSent, id).toBe(0)
  }
  expect(row("preflight-refused-no-copy").outcome).toMatchObject({ answerStatus: 200, answerIsPrimarys: true })
  expect(row("preflight-primary-429-no-copy").outcome.answerStatus).toBe(429)
  expect(row("preflight-primary-500-no-copy").outcome.answerStatus).toBe(500)
  expect(row("preflight-primary-unreachable-rejects")).toMatchObject({ outcome: { rejected: true, copiesSent: 0 } })
  expect(hosts(row("preflight-primary-unreachable-rejects"))).toEqual(["primary.test"])
})

test("a resend that already skips preflight goes to every endpoint at once, even when the primary then refuses", () => {
  const r = row("resend-skip-preflight-all-at-once")
  expect(r.outcome).toMatchObject({ copiesOnWireBeforePrimaryAnswered: 2, sameBytes: true, answerIsPrimarys: true })
  expect(r.calls!.every((c) => c.skipPreflight === true)).toBe(true)
  const refused = row("resend-primary-refuses-copies-still-leave")
  expect([...hosts(refused)].sort()).toEqual(["extra-a.test", "primary.test"])
  expect(refused.outcome.answerIsPrimarys).toBe(true)
})

test("a copy that fails changes nothing for the caller and is reported by a short class only", () => {
  const failing = scenario("copy-failure").filter((r) => r.id !== "copy-slow-does-not-delay-the-answer")
  expect(failing.map((r) => r.outcome.copyFailures[0].reason)).toEqual(["http 429", "rpc -32002", "rpc error", "network", "timeout"])
  for (const r of failing) {
    expect(r.outcome).toMatchObject({ answerStatus: 200, answerIsPrimarys: true, otherCopySent: true })
    expect(r.outcome.copyFailures).toHaveLength(1)
    expect(r.outcome.copyFailures[0].index).toBe(0)
    expect(r.outcome.copyFailures[0].reason, r.id).toMatch(MAPPED_REASON)
  }
  expect(row("copy-slow-does-not-delay-the-answer").outcome).toMatchObject({ answerStatus: 200, answeredBeforeCopySettled: true })
})

test("every failure class a row carries is a mapped one, and no endpoint or error text is in any of them", () => {
  const reasons = rows.flatMap((r) => (r.outcome.copyFailures ?? []).map((f: { reason: string }) => f.reason))
  expect(reasons.length).toBeGreaterThan(0)
  for (const reason of reasons) expect(reason).toMatch(MAPPED_REASON)
})

test("only one sendTransaction fans out: not a batch, not a read, not a simulation, and a send with no bytes has nothing to copy", () => {
  expect(row("shape-single-send").outcome.fansOut).toBe(true)
  for (const id of ["batch-of-sends", "other-method", "simulate-is-not-a-send", "not-an-object"]) expect(row(`shape-${id}`).outcome.fansOut, id).toBe(false)
  expect(hosts(row("send-without-bytes-no-copy"))).toEqual(["primary.test"])
})

test("no recorded call is anything but a plain sendTransaction: no tip, no other method, no tip-paid sender", () => {
  const calls = rows.flatMap((r) => r.calls ?? [])
  expect(calls.length).toBeGreaterThan(0)
  for (const c of calls) expect(c.method).toBe("sendTransaction")
  expect(calls.some((c) => /helius|jito/i.test(c.host))).toBe(false)
})

test("the web side's source holds what the card changed: the proxy asked for by address, only the send redirected, the quote started by a signed-in press and never a buy", () => {
  const pins = scenario("source-pin")
  expect(pins.map((p) => p.id)).toEqual([
    "proxy-fans-out-only-on-request", "proxy-answer-is-the-primarys", "send-url-is-the-proxy-with-fanout", "send-url-only-for-the-proxy-path",
    "only-the-send-is-redirected", "quote-warm-draws-nothing", "quote-warm-never-buys", "press-on-the-button-starts-the-quote", "signed-out-press-warms-nothing",
  ])
  expect(row("quote-warm-never-buys").outcome.found).toBe(false)
  for (const p of pins.filter((x) => x.id !== "quote-warm-never-buys")) expect(p.outcome.found, p.id).toBe(true)
})
