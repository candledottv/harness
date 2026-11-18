// Offline multi-RPC send contracts (BE-3925) from an exact clean Candle source checkout: what the API's RPC proxy does
// with one signed transaction, recorded by running its own source (apps/api/src/services/solana/send-fanout.ts, the
// module routes/rpc.ts calls for `?fanout=1`) against stand-ins for every endpoint.
//   1. the extra endpoints: unset on a deployed instance is Solana's public endpoint, unset locally is none, blank is
//      none, and an entry that is not https, carries userinfo, repeats or is the primary is dropped;
//   2. a send with preflight goes to the primary alone first, and copies leave only after the primary answered with a
//      signature, so a refused send stays unsent; the copy is the same bytes, never simulated again;
//   3. a send that already skips preflight goes to every endpoint at once;
//   4. the caller's answer is the primary's own, byte for byte, and no copy delays or changes it; a copy that fails is
//      reported by a short class only, never an endpoint or an error text;
//   5. only one `sendTransaction` fans out: a batch or any other method never does.
// The web side of the same card (the quick-buy quote started on press, the swap sender's fan-out address) is React and
// a browser; it has no process to run here. The recorder pins its source facts as text, from the same commit.
// Every fetch is a stand-in; no address, key, endpoint or signature is real.
//   bun scripts/read-fanout-source.ts <candle-monorepo checkout>
// The checkout needs no dependencies installed.
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const checkout = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("usage: bun scripts/read-fanout-source.ts <candle-monorepo checkout>")
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`source git check failed: ${r.stderr}`)
  return r.stdout.trim()
}
git("diff", "--exit-code", "HEAD", "--", "apps/api/src", "apps/frontend/src")
const FILES = [
  "apps/api/src/services/solana/send-fanout.ts",
  "apps/api/src/routes/rpc.ts",
  "apps/frontend/src/hooks/tokens/swap-send.ts",
  "apps/frontend/src/components/trade/quick-buy-button.tsx",
  "apps/frontend/src/components/trade/roster-board.tsx",
]
const source = {
  repo: "candledottv/candle-monorepo", commit: git("rev-parse", "HEAD"),
  versions: Object.fromEntries(["cli", "mcp", "sdk"].map((p) => [p, JSON.parse(readFileSync(join(checkout, "packages", p, "package.json"), "utf8")).version])),
  files: FILES,
}
const text = (path: string) => readFileSync(join(checkout, path), "utf8")
const fanout = await import(pathToFileURL(join(checkout, FILES[0]!)).href)
const { extraSendRpcUrls, isSingleSend, sendThroughAll, SOLANA_PUBLIC_SEND_RPC_URL } = fanout

const PRIMARY = "https://primary.test/?api-key=fixture-only-not-a-key"
const EXTRA_A = "https://extra-a.test/"
const EXTRA_B = "https://extra-b.test/rpc?api-key=fixture-only-not-a-key"
const SIGNED = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA="
const SIGNATURE = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW"
const hostOf = (url: string) => new URL(url).host

type Call = { n: number; host: string; method: string; skipPreflight?: boolean; maxRetries?: number; minContextSlot?: boolean; sameBytes: boolean; encoding?: string }
type Row = { id: string; scenario: string; args: Record<string, unknown>; calls?: Call[]; outcome: Record<string, unknown> }
const rows: Row[] = []
const rpcJson = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
const accepted = () => rpcJson({ jsonrpc: "2.0", id: 7, result: SIGNATURE })
const refused = () => rpcJson({ jsonrpc: "2.0", id: 7, error: { code: -32002, message: "Transaction simulation failed" } })
const send = (config: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 7, method: "sendTransaction" as const, params: [SIGNED, config] })
const withPreflight = send({ encoding: "base64", skipPreflight: false, maxRetries: 5, minContextSlot: 123 })
const resend = send({ encoding: "base64", skipPreflight: true, maxRetries: 0 })

type Answer = (signal: AbortSignal | undefined) => Response | Promise<Response>
/** A fetch whose answer per host is scripted; every call is recorded in the order it reached the wire. */
function world(answers: Record<string, Answer>) {
  const calls: Call[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body))
    const config = (body.params?.[1] ?? {}) as Record<string, unknown>
    calls.push({
      n: calls.length + 1, host: hostOf(url), method: body.method,
      ...(config.skipPreflight === undefined ? {} : { skipPreflight: config.skipPreflight as boolean }),
      ...(config.maxRetries === undefined ? {} : { maxRetries: config.maxRetries as number }),
      minContextSlot: "minContextSlot" in config, sameBytes: body.params?.[0] === SIGNED,
      ...(typeof config.encoding === "string" ? { encoding: config.encoding } : {}),
    })
    const answer = answers[hostOf(url)]
    if (!answer) throw new Error(`unexpected endpoint ${hostOf(url)}`)
    return answer(init?.signal ?? undefined)
  }) as typeof fetch
  return { fetcher, calls }
}
const neverEnds: Answer = (signal) => new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))))

async function run(id: string, scenario: string, body: any, answers: Record<string, Answer>, extra: string[], extras: { timeoutMs?: number } = {}) {
  const w = world(answers)
  const failed: Array<[number, string]> = []
  const started = performance.now()
  const result = await sendThroughAll(body, { primaryUrl: PRIMARY, extraUrls: extra, fetch: w.fetcher, timeoutMs: extras.timeoutMs, onCopyFailed: (i: number, reason: string) => failed.push([i, reason]) })
  const answeredAfterMs = performance.now() - started
  await result.copies
  return { id, scenario, w, result, failed, answeredAfterMs }
}
function record(r: Awaited<ReturnType<typeof run>>, args: Record<string, unknown>, outcome: Record<string, unknown>) {
  rows.push({ id: r.id, scenario: r.scenario, args, calls: r.w.calls, outcome: { answerStatus: r.result.status, copyFailures: r.failed.map(([index, reason]) => ({ index, reason })), ...outcome } })
}

// 1. The endpoints a fan-out copies to.
{
  const deployed = { RAILWAY_ENVIRONMENT: "production", SOLANA_RPC_URL: PRIMARY }
  const cases: Array<[string, Record<string, string | undefined>, string[]]> = [
    ["unset-deployed", deployed, [`${SOLANA_PUBLIC_SEND_RPC_URL}/`]],
    ["unset-production-build", { NODE_ENV: "production", SOLANA_RPC_URL: PRIMARY }, [`${SOLANA_PUBLIC_SEND_RPC_URL}/`]],
    ["unset-local", { SOLANA_RPC_URL: "http://127.0.0.1:8899" }, []],
    ["blank-deployed", { ...deployed, SOLANA_EXTRA_SEND_RPC_URLS: "" }, []],
    ["blank-local", { SOLANA_EXTRA_SEND_RPC_URLS: "" }, []],
    ["two-listed", { ...deployed, SOLANA_EXTRA_SEND_RPC_URLS: `${EXTRA_A}, ${EXTRA_B}` }, [EXTRA_A, EXTRA_B]],
    ["not-https-dropped", { ...deployed, SOLANA_EXTRA_SEND_RPC_URLS: `http://extra-a.test/,not a url,${EXTRA_A}` }, [EXTRA_A]],
    ["userinfo-dropped", { ...deployed, SOLANA_EXTRA_SEND_RPC_URLS: `https://user:pass@extra-a.test/,${EXTRA_A}` }, [EXTRA_A]],
    ["repeat-and-primary-dropped", { ...deployed, SOLANA_EXTRA_SEND_RPC_URLS: `${EXTRA_A},${EXTRA_A},${PRIMARY}` }, [EXTRA_A]],
    ["capped-at-four", { ...deployed, SOLANA_EXTRA_SEND_RPC_URLS: [1, 2, 3, 4, 5, 6].map((n) => `https://extra-${n}.test/`).join(",") }, [1, 2, 3, 4].map((n) => `https://extra-${n}.test/`)],
  ]
  for (const [id, env, want] of cases) {
    const got = extraSendRpcUrls(env)
    assert.deepEqual(got, want, id)
    rows.push({ id: `endpoints-${id}`, scenario: "endpoints", args: { deployed: Boolean(env.RAILWAY_ENVIRONMENT) || env.NODE_ENV === "production", listed: env.SOLANA_EXTRA_SEND_RPC_URLS === undefined ? "unset" : env.SOLANA_EXTRA_SEND_RPC_URLS === "" ? "blank" : "set" }, outcome: { hosts: got.map(hostOf) } })
  }
  // The public endpoint is never reached by a recorded send: its host is only ever named as a default.
}

// 2. A send with preflight: primary first, copies only after it answered with a signature.
{
  const both = { "primary.test": accepted, "extra-a.test": accepted, "extra-b.test": accepted }
  const r = await run("preflight-accepted-copies-follow", "preflight", withPreflight, both, [EXTRA_A, EXTRA_B])
  assert.deepEqual(r.w.calls.map((c) => c.host), ["primary.test", "extra-a.test", "extra-b.test"])
  assert.ok(r.w.calls.every((c) => c.sameBytes && c.method === "sendTransaction"))
  assert.ok(r.w.calls.slice(1).every((c) => c.skipPreflight === true && c.maxRetries === 5 && !c.minContextSlot && c.encoding === "base64"))
  assert.equal(r.w.calls[0]!.skipPreflight, false)
  assert.equal(r.result.text, JSON.stringify({ jsonrpc: "2.0", id: 7, result: SIGNATURE }))
  record(r, { preflight: true, extras: 2 }, { primaryFirst: true, copiesAfterAnswer: true, sameBytes: true, copiesSkipPreflight: true, minContextSlotLeftOut: true, answerIsPrimarys: true })

  const refusedRun = await run("preflight-refused-no-copy", "preflight", withPreflight, { ...both, "primary.test": refused }, [EXTRA_A, EXTRA_B])
  assert.deepEqual(refusedRun.w.calls.map((c) => c.host), ["primary.test"])
  assert.equal(refusedRun.result.text, JSON.stringify({ jsonrpc: "2.0", id: 7, error: { code: -32002, message: "Transaction simulation failed" } }))
  record(refusedRun, { preflight: true, primary: "simulation refused" }, { copiesSent: 0, answerIsPrimarys: true })

  for (const [id, answer, label] of [
    ["primary-429", () => rpcJson({ error: "rate limited" }, 429), "http 429"],
    ["primary-500", () => new Response("upstream down", { status: 500 }), "http 500"],
    ["primary-not-json", () => new Response("<html>gateway</html>", { status: 200 }), "html at 200"],
    ["primary-empty-result", () => rpcJson({ jsonrpc: "2.0", id: 7, result: "" }), "empty signature"],
  ] as const) {
    const x = await run(`preflight-${id}-no-copy`, "preflight", withPreflight, { ...both, "primary.test": answer }, [EXTRA_A])
    assert.deepEqual(x.w.calls.map((c) => c.host), ["primary.test"], id)
    record(x, { preflight: true, primary: label }, { copiesSent: 0, answerIsPrimarys: true })
  }

  const unreachable = world({ "primary.test": () => { throw new TypeError("fetch failed") }, "extra-a.test": accepted })
  await assert.rejects(sendThroughAll(withPreflight, { primaryUrl: PRIMARY, extraUrls: [EXTRA_A], fetch: unreachable.fetcher }), TypeError)
  assert.deepEqual(unreachable.calls.map((c) => c.host), ["primary.test"])
  rows.push({ id: "preflight-primary-unreachable-rejects", scenario: "preflight", args: { preflight: true, primary: "unreachable" }, calls: unreachable.calls, outcome: { rejected: true, copiesSent: 0 } })
}

// 3. A send that already skips preflight goes to every endpoint at once.
{
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  let copiesOnWireBeforePrimaryAnswered = 0
  const w = world({
    "primary.test": async () => { await new Promise((r) => setTimeout(r, 20)); copiesOnWireBeforePrimaryAnswered = w.calls.filter((c) => c.host !== "primary.test").length; release(); return accepted() },
    "extra-a.test": accepted, "extra-b.test": accepted,
  })
  const result = await sendThroughAll(resend, { primaryUrl: PRIMARY, extraUrls: [EXTRA_A, EXTRA_B], fetch: w.fetcher })
  await result.copies; await held
  assert.equal(copiesOnWireBeforePrimaryAnswered, 2)
  assert.ok(w.calls.every((c) => c.sameBytes && c.skipPreflight === true))
  rows.push({ id: "resend-skip-preflight-all-at-once", scenario: "resend", args: { preflight: false, extras: 2 }, calls: w.calls, outcome: { answerStatus: result.status, copiesOnWireBeforePrimaryAnswered, sameBytes: true, answerIsPrimarys: true } })

  const refusedResend = await run("resend-primary-refuses-copies-still-leave", "resend", resend, { "primary.test": () => rpcJson({ jsonrpc: "2.0", id: 7, error: { code: -32003, message: "Transaction signature verification failure" } }), "extra-a.test": accepted }, [EXTRA_A])
  assert.deepEqual(refusedResend.w.calls.map((c) => c.host).sort(), ["extra-a.test", "primary.test"])
  record(refusedResend, { preflight: false, primary: "refuses" }, { copiesSent: 1, answerIsPrimarys: true })
}

// 4. A copy never delays or changes the caller's answer, and its failure names nothing.
{
  const labels: Array<[string, Answer, string]> = [
    ["copy-http-429", () => rpcJson({}, 429), "http 429"],
    ["copy-rpc-refusal", () => rpcJson({ jsonrpc: "2.0", id: 7, error: { code: -32002, message: "https://extra-a.test/?api-key=fixture-only-not-a-key leaked" } }), "rpc -32002"],
    ["copy-rpc-error-without-code", () => rpcJson({ jsonrpc: "2.0", id: 7, error: { message: "odd" } }), "rpc error"],
    ["copy-network", () => { throw new TypeError("connect ECONNREFUSED extra-a.test") }, "network"],
    ["copy-timeout", neverEnds, "timeout"],
  ]
  for (const [id, answer, reason] of labels) {
    const r = await run(id, "copy-failure", withPreflight, { "primary.test": accepted, "extra-a.test": answer, "extra-b.test": accepted }, [EXTRA_A, EXTRA_B], { timeoutMs: 40 })
    assert.deepEqual(r.failed, [[0, reason]], id)
    assert.equal(r.result.text, JSON.stringify({ jsonrpc: "2.0", id: 7, result: SIGNATURE }))
    assert.ok(!JSON.stringify(r.failed).includes("api-key") && !JSON.stringify(r.failed).includes("extra-a"), `${id}: a failure names no endpoint`)
    record(r, { preflight: true, failing: "first copy" }, { answerIsPrimarys: true, otherCopySent: r.w.calls.some((c) => c.host === "extra-b.test") })
  }
  // The answer does not wait for a slow copy.
  const slow = world({ "primary.test": accepted, "extra-a.test": neverEnds })
  const t0 = performance.now()
  const result = await sendThroughAll(withPreflight, { primaryUrl: PRIMARY, extraUrls: [EXTRA_A], fetch: slow.fetcher, timeoutMs: 300 })
  const answeredInMs = performance.now() - t0
  assert.ok(answeredInMs < 150, `the answer waited ${answeredInMs}ms for a copy`)
  await result.copies
  rows.push({ id: "copy-slow-does-not-delay-the-answer", scenario: "copy-failure", args: { preflight: true, copyTimeoutMs: 300 }, calls: slow.calls, outcome: { answerStatus: result.status, answeredBeforeCopySettled: true } })
}

// 5. Only one sendTransaction fans out.
{
  const shapes: Array<[string, unknown, boolean]> = [
    ["single-send", withPreflight, true],
    ["batch-of-sends", [withPreflight, withPreflight], false],
    ["other-method", { jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [] }, false],
    ["simulate-is-not-a-send", { jsonrpc: "2.0", id: 1, method: "simulateTransaction", params: [SIGNED] }, false],
    ["not-an-object", null, false],
  ]
  for (const [id, body, want] of shapes) {
    assert.equal(isSingleSend(body), want, id)
    rows.push({ id: `shape-${id}`, scenario: "shape", args: { shape: id }, outcome: { fansOut: want } })
  }
  // A send with no transaction in it has nothing to copy: the primary answers alone.
  const empty = await run("send-without-bytes-no-copy", "shape", { jsonrpc: "2.0", id: 7, method: "sendTransaction", params: [] }, { "primary.test": () => rpcJson({ jsonrpc: "2.0", id: 7, error: { code: -32602, message: "Invalid params" } }), "extra-a.test": accepted }, [EXTRA_A])
  assert.deepEqual(empty.w.calls.map((c) => c.host), ["primary.test"])
  rows.push({ id: empty.id, scenario: "shape", args: { shape: "send without bytes" }, calls: empty.w.calls.map((c) => ({ ...c, sameBytes: false })), outcome: { copiesSent: 0 } })
}

// Source facts at the pinned commit: the web side, which has no process to run here.
const proxy = text(FILES[1]!)
const swapSend = text(FILES[2]!)
const warm = text(FILES[3]!)
const board = text(FILES[4]!)
const pin = (id: string, file: string, haystack: string, needle: RegExp, found = true) => {
  assert.equal(needle.test(haystack), found, `${id}: ${needle}`)
  rows.push({ id, scenario: "source-pin", args: { file }, outcome: { found } })
}
pin("proxy-fans-out-only-on-request", FILES[1]!, proxy, /c\.req\.query\("fanout"\) === "1" && isSingleSend\(body\)/)
pin("proxy-answer-is-the-primarys", FILES[1]!, proxy, /new Response\(sent\.text, \{\s*status: sent\.status/)
pin("send-url-is-the-proxy-with-fanout", FILES[2]!, swapSend, /url\.searchParams\.set\("fanout", "1"\)/)
pin("send-url-only-for-the-proxy-path", FILES[2]!, swapSend, /pathname\.replace\(\/\\\/\+\$\/, ""\) !== RPC_PROXY_PATH/)
pin("only-the-send-is-redirected", FILES[2]!, swapSend, /property === "sendRawTransaction"/)
pin("quote-warm-draws-nothing", FILES[3]!, warm, /export function QuickBuyQuoteWarm[\s\S]*?useRosterQuickBuy\(token, usdAmount\)\s*return null/)
pin("quote-warm-never-buys", FILES[3]!, warm.slice(warm.indexOf("export function QuickBuyQuoteWarm"), warm.indexOf("export function QuickBuyButton")), /execute\(/, false)
pin("press-on-the-button-starts-the-quote", FILES[4]!, board, /onPointerDown=\{signIn \? undefined : \(\) => setPressed\(true\)\}/)
pin("signed-out-press-warms-nothing", FILES[4]!, board, /pressed && !signIn \? <QuickBuyQuoteWarm/)

const textOut = JSON.stringify(rows)
for (const secret of ["fixture-only-not-a-key", "primary-secret", "extra-secret", "BEGIN", SIGNED, SIGNATURE]) assert.ok(!textOut.includes(secret), `a fixture carries ${secret}`)
const hosts = new Set(rows.flatMap((r) => [...(r.calls ?? []).map((c) => c.host), ...(Array.isArray((r.outcome as any).hosts) ? (r.outcome as any).hosts : [])]))
for (const h of hosts) assert.ok(h === SOLANA_PUBLIC_SEND_RPC_URL.slice("https://".length) || /\.test$/.test(h), `${h} is not a made-up host`)
writeFileSync(join(import.meta.dir, "../test/fixtures/candle-fanout-source.json"), `${JSON.stringify({
  about: "Offline multi-RPC send contracts (BE-3925): which extra endpoints a send copies to; a send with preflight goes to the primary first and copies leave only after it answered with a signature; a resend that skips preflight goes everywhere at once; the answer is the primary's own and no copy delays or changes it; one sendTransaction only. Recorded by running the API's own fan-out source against stand-ins from an exact staging commit; every fetch is intercepted. The web side (quote started on press, the swap sender's fan-out address) is pinned as source text. The commit is a staging build and changes no CLI, MCP or SDK file: their published versions are the ones named in the source block.",
  source, rows,
}, null, 2)}\n`)
console.log(`Recorded ${rows.length} offline multi-RPC send contracts from ${source.commit}.`)
