// Offline API pre-sign guard and fast-market stop-loss docs contracts (BE-3904, BE-4292, BE-4343, BE-4344) from an
// exact clean Candle source checkout at the published release commit (`5d7a861a8`, matching `@candledottv/agent-sdk`
// 0.6.39; the SDK, MCP and CLI package contracts themselves are recorded from the published npm tarballs by
// `scripts/run-presign-refused-packages.ts`):
//   1. api-presign: `simulationSlippageExceeded` (Jupiter v6 custom error 6001 -> `cause: "slippage_exceeded"`, with
//                   inner-CPI and diagnostic-only 6001 logs excluded), `redactPresignDetail`, `errorBody`,
//                   `AGENT_MAX_SLIPPAGE_BPS` (5,000), `trade-agent.ts` default `maxSlippageBps` (100) and
//                   `countRisk: false` on pre-sign refusals;
//   2. docs:        `Fast markets and stop losses` verified byte-identical across all three `agent-trading.md` copies,
//                   `apps/docs/src/content/docs/developers/sdk.md` and `packages/sdk/CHANGELOG.md` recorded, and the
//                   `fastConnectFetch` connect-timeout wrapper executed offline across reads, trade builds, submits,
//                   confirms, executes and other origins.
// Every fetch is refused: nothing reaches a network and no real key or wallet is used.
//   bun scripts/read-presign-refused-source.ts <candle-monorepo checkout>
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const checkout = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("usage: bun scripts/read-presign-refused-source.ts <candle-monorepo checkout>")
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`source git check failed: ${r.stderr}`)
  return r.stdout.trim()
}
const FILES = [
  "apps/api/src/services/solana/presign-guard.ts",
  "apps/api/src/lib/launch-errors.ts",
  "apps/api/src/lib/agent-slippage.ts",
  "apps/api/src/routes/trade-agent.ts",
  "docs/agent-trading.md",
  "apps/docs/src/content/docs/developers/agent-trading.md",
  "apps/frontend/public/docs/agent-trading.md",
  "apps/docs/src/content/docs/developers/sdk.md",
  "packages/sdk/CHANGELOG.md",
]
git("diff", "--exit-code", "HEAD", "--", ...FILES)
const text = (path: string) => readFileSync(join(checkout, path), "utf8")
for (const f of FILES) text(f)
const source = {
  repo: "candledottv/candle-monorepo",
  commit: git("rev-parse", "HEAD"),
  versions: Object.fromEntries(["cli", "mcp", "sdk"].map((p) => [p, JSON.parse(text(`packages/${p}/package.json`)).version])),
  files: FILES,
}

const dbExports = JSON.parse(text("packages/db/package.json")).exports as Record<string, string | { default: string }>
const load = (path: string) => import(pathToFileURL(join(checkout, path)).href)
Bun.plugin({
  name: "presign-refused-source-workspaces",
  setup(build) {
    build.onResolve({ filter: /^@candle\/shared$/ }, () => ({ path: join(checkout, "packages/shared/src/index.ts") }))
    build.onResolve({ filter: /^@candle\/db(\/.*)?$/ }, ({ path }) => {
      const sub = path === "@candle/db" ? "." : `.${path.slice("@candle/db".length)}`
      const entry = dbExports[sub]
      const rel = typeof entry === "string" ? entry : entry?.default
      if (!rel) throw new Error(`unknown @candle/db export: ${path}`)
      return { path: join(checkout, "packages/db", rel) }
    })
  },
})

const originalFetch = globalThis.fetch
globalThis.fetch = (() => {
  throw new Error("presign-refused source recording may not access the network")
}) as unknown as typeof fetch

const API = "https://api.test"
const OTHER_ORIGIN = "https://rpc.private.test"
const PAYER = "PayrFake11111111111111111111111111111111111"
const OTHER_WALLET = "Dex2Fake11111111111111111111111111111111111"
const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
const DOC_COPIES = [
  "docs/agent-trading.md",
  "apps/docs/src/content/docs/developers/agent-trading.md",
  "apps/frontend/public/docs/agent-trading.md",
]

type Row = {
  id: string
  scenario: "api-presign" | "docs"
  args: Record<string, unknown>
  outcome: Record<string, unknown>
}
const rows: Row[] = []
const record = (id: string, scenario: Row["scenario"], args: Record<string, unknown>, outcome: Record<string, unknown>) =>
  rows.push({ id, scenario, args, outcome })

const scrub = (s: string) => s.replaceAll(PAYER, "<payer>").replaceAll(OTHER_WALLET, "<other>")

try {
  const { simulationSlippageExceeded, redactPresignDetail } = await load("apps/api/src/services/solana/presign-guard.ts")
  const { errorBody } = await load("apps/api/src/lib/launch-errors.ts")
  const { AGENT_MAX_SLIPPAGE_BPS } = await load("apps/api/src/lib/agent-slippage.ts")

  // 1. API pre-sign guard classification, inner-CPI exclusion, redaction, wire envelope and slippage bounds.
  {
    const err6001 = { InstructionError: [3, { Custom: 6001 }] }
    const jupLogs = [`Program ${JUPITER_V6} failed: custom program error: 0x1771`]
    const innerCpiLogs = [
      `Program ${JUPITER_V6} invoke [1]`,
      `Program ${OTHER_WALLET} invoke [2]`,
      `Program ${OTHER_WALLET} failed: custom program error: 0x1771`,
      `Program ${JUPITER_V6} failed: custom program error: 0x1771`,
    ]
    const diagnosticBeforeJupLogs = [
      "Program log: failed: diagnostic from an earlier hop",
      `Program ${JUPITER_V6} failed: custom program error: 0x1771`,
    ]
    assert.equal(simulationSlippageExceeded(err6001, jupLogs), true)
    assert.equal(simulationSlippageExceeded(err6001, [`Program ${OTHER_WALLET} failed: custom program error: 0x1771`]), false)
    assert.equal(simulationSlippageExceeded(err6001, innerCpiLogs), false, "inner CPI 0x1771 is not attributed to Jupiter")
    assert.equal(simulationSlippageExceeded(err6001, diagnosticBeforeJupLogs), true, "Program log: failed: does not mask Jupiter")
    assert.equal(simulationSlippageExceeded({ InstructionError: [3, { Custom: 6000 }] }, jupLogs), false)
    assert.equal(simulationSlippageExceeded(err6001, null), false)

    const guardSource = text("apps/api/src/services/solana/presign-guard.ts")
    const sentenceMatch = /const SLIPPAGE_EXCEEDED_SENTENCE =\s*"([^"]+)"/.exec(guardSource)
    assert.ok(sentenceMatch?.[1], "missing SLIPPAGE_EXCEEDED_SENTENCE in presign-guard.ts")
    const sentence = sentenceMatch[1]
    assert.ok(sentence.includes("maxSlippageBps (default 100, cap 5000)"))

    const rawDetail = `${sentence} (${JSON.stringify(err6001)}; payer ${PAYER} pool ${OTHER_WALLET}; Program ${JUPITER_V6} failed: custom program error: 0x1771)`
    const redacted = redactPresignDetail(rawDetail, [PAYER])
    assert.ok(redacted.includes("maxSlippageBps (default 100, cap 5000)"))
    assert.ok(redacted.includes(PAYER), "caller payer kept before fixture scrub")
    assert.ok(!redacted.includes(JUPITER_V6), "Jupiter program id redacted")
    assert.ok(!redacted.includes(OTHER_WALLET), "other address redacted")

    const envelope = errorBody(
      "SWAP_FAILED",
      "The built transaction failed the pre-sign safety check (simulation_failed); nothing was signed or sent.",
      {
        retryable: true,
        stage: "not_broadcast",
        reason: "presign_refused",
        refusal: "simulation_failed",
        detail: scrub(redacted),
        cause: "slippage_exceeded",
      },
    )
    record(
      "api-jupiter-6001-labelled-and-redacted",
      "api-presign",
      { err: err6001, program: "<jupiter-v6>" },
      {
        slippageExceeded: true,
        otherProgram6001: false,
        innerCpi6001: false,
        diagnosticBeforeJupiter6001: true,
        jupiter6000: false,
        nullLogs: false,
        jupiterIdRedacted: !redacted.includes(JUPITER_V6),
        otherAddressRedacted: !redacted.includes(OTHER_WALLET),
        envelope,
      },
    )

    const routeSource = text("apps/api/src/routes/trade-agent.ts")
    const defaultMatch = /let maxSlippageBps = (\d+)/.exec(routeSource)
    assert.ok(defaultMatch, "trade-agent.ts default maxSlippageBps found")
    const defaultBps = Number(defaultMatch[1])
    assert.equal(defaultBps, 100)
    assert.equal(AGENT_MAX_SLIPPAGE_BPS, 5_000)
    const countRiskFalse = /refusePresignedTrade[\s\S]{0,1600}?failRow\("SWAP_FAILED", \{ countRisk: false \}\)/.test(routeSource)
    assert.equal(countRiskFalse, true, "refusePresignedTrade records SWAP_FAILED with countRisk: false")
    record(
      "api-slippage-bounds-and-risk-breaker",
      "api-presign",
      { route: "/api/v1/trade/agent/build" },
      { defaultMaxSlippageBps: defaultBps, capMaxSlippageBps: AGENT_MAX_SLIPPAGE_BPS, presignCountsTowardRiskBreaker: !countRiskFalse },
    )
  }

  // 2. Docs parity (`Fast markets and stop losses`, SDK docs `Errors`, SDK changelog, and `fastConnectFetch` execution).
  {
    const extractSection = (md: string, heading: string) => {
      const m = new RegExp(`(?:^|\\n)(#{2,3} ${heading}\\n[\\s\\S]*?)(?=\\n#{1,2} |$)`).exec(md)
      assert.ok(m?.[1], `missing section "${heading}"`)
      return m[1].trim()
    }
    const sections = DOC_COPIES.map((p) => extractSection(text(p), "Fast markets and stop losses"))
    assert.equal(sections[1], sections[0], `${DOC_COPIES[1]} differs from ${DOC_COPIES[0]}`)
    assert.equal(sections[2], sections[0], `${DOC_COPIES[2]} differs from ${DOC_COPIES[0]}`)

    const sdkDocsErrors = extractSection(text("apps/docs/src/content/docs/developers/sdk.md"), "Errors").split("\n\n")[1]!
    const sdkChangelogLine = text("packages/sdk/CHANGELOG.md")
      .split("\n")
      .find((line) => line.startsWith("Release 0.6.37 "))
    assert.ok(sdkChangelogLine, "missing SDK 0.6.37 changelog line")

    record(
      "docs-fast-markets-and-stop-losses",
      "docs",
      { files: DOC_COPIES },
      {
        identicalCopies: true,
        text: sections[0],
        sdkDocsErrors,
        sdkChangelogEntry: sdkChangelogLine,
      },
    )

    const codeMatch = /```ts\n([\s\S]*?)\n```/.exec(sections[0]!)
    assert.ok(codeMatch?.[1], "missing TypeScript snippet in Fast markets and stop losses")
    const snippet = codeMatch[1]
    assert.ok(snippet.includes("UND_ERR_CONNECT_TIMEOUT"), "snippet checks UND_ERR_CONNECT_TIMEOUT")
    assert.ok(snippet.includes("3_000"), "snippet configures 3_000 ms connect timeout")

    const bodyOnly = snippet
      .split("\n")
      .filter((line) => !line.startsWith("import "))
      .join("\n")
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`${bodyOnly}\nreturn fastConnectFetch;`)
    const makeWrapper = new Function("Agent", "undiciFetch", "fetch", js) as (
      AgentCtor: new (opts: unknown) => unknown,
      undiciFn: (input: unknown, init?: RequestInit) => Promise<Response>,
      defaultFetch: (input: unknown, init?: RequestInit) => Promise<Response>,
    ) => (apiUrl: string) => typeof fetch

    const connectCases: {
      id: string
      method: string
      url: string
      body?: Record<string, unknown>
      failures: string[]
      expectRetry: boolean
      expectThrow?: string
    }[] = [
      {
        id: "docs-connect-retry-get-read",
        method: "GET",
        url: `${API}/api/v1/markets/feed`,
        failures: ["UND_ERR_CONNECT_TIMEOUT"],
        expectRetry: true,
      },
      {
        id: "docs-connect-retry-trade-build",
        method: "POST",
        url: `${API}/api/v1/trade/agent/build`,
        body: { clientTradeId: "connect-build-1", mint: "<mint>", side: "sell", amountRaw: "1000" },
        failures: ["UND_ERR_CONNECT_TIMEOUT"],
        expectRetry: true,
      },
      {
        id: "docs-connect-second-timeout-throws",
        method: "POST",
        url: `${API}/api/v1/trade/agent/build`,
        body: { clientTradeId: "connect-build-2", mint: "<mint>", side: "buy", amountRaw: "1000" },
        failures: ["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT"],
        expectRetry: true,
        expectThrow: "UND_ERR_CONNECT_TIMEOUT",
      },
      {
        id: "docs-connect-headers-timeout-no-retry",
        method: "POST",
        url: `${API}/api/v1/trade/agent/build`,
        body: { clientTradeId: "connect-build-3", mint: "<mint>", side: "buy", amountRaw: "1000" },
        failures: ["UND_ERR_HEADERS_TIMEOUT"],
        expectRetry: false,
        expectThrow: "UND_ERR_HEADERS_TIMEOUT",
      },
      {
        id: "docs-connect-submit-never-retried",
        method: "POST",
        url: `${API}/api/v1/trade/agent/submit`,
        body: { clientTradeId: "submit-1", signedTransaction: "<signed>" },
        failures: ["UND_ERR_CONNECT_TIMEOUT"],
        expectRetry: false,
        expectThrow: "UND_ERR_CONNECT_TIMEOUT",
      },
      {
        id: "docs-connect-confirm-never-retried",
        method: "POST",
        url: `${API}/api/v1/trade/agent/confirm`,
        body: { clientTradeId: "confirm-1", signature: "<sig>" },
        failures: ["UND_ERR_CONNECT_TIMEOUT"],
        expectRetry: false,
        expectThrow: "UND_ERR_CONNECT_TIMEOUT",
      },
      {
        id: "docs-connect-execute-never-retried",
        method: "POST",
        url: `${API}/api/v1/trade/agent/execute`,
        body: { clientTradeId: "execute-1" },
        failures: ["UND_ERR_CONNECT_TIMEOUT"],
        expectRetry: false,
        expectThrow: "UND_ERR_CONNECT_TIMEOUT",
      },
      {
        id: "docs-connect-other-origin-never-retried",
        method: "GET",
        url: `${OTHER_ORIGIN}/health`,
        failures: ["UND_ERR_CONNECT_TIMEOUT"],
        expectRetry: false,
        expectThrow: "UND_ERR_CONNECT_TIMEOUT",
      },
    ]

    for (const c of connectCases) {
      let agentOptions: unknown
      class FakeAgent {
        constructor(opts: unknown) {
          agentOptions = opts
        }
      }
      const attempts: { transport: "undici" | "default"; method: string; path: string; body: unknown; redirect?: string }[] = []
      let idx = 0
      const step = (transport: "undici" | "default") => async (input: unknown, init?: RequestInit) => {
        const u = new URL(String(input))
        attempts.push({
          transport,
          method: (init?.method ?? "GET").toUpperCase(),
          path: u.pathname,
          body: init?.body ? JSON.parse(String(init.body)) : null,
          ...(init?.redirect ? { redirect: init.redirect } : {}),
        })
        const code = c.failures[idx++]
        if (code) {
          throw new TypeError("fetch failed", { cause: { code } })
        }
        return Response.json({ ok: true })
      }
      const fastFetch = makeWrapper(FakeAgent, step("undici"), step("default"))(API)
      let threwCode: string | null = null
      let status: number | null = null
      try {
        const res = await fastFetch(c.url, {
          method: c.method,
          ...(c.body ? { body: JSON.stringify(c.body) } : {}),
        })
        status = res.status
      } catch (e: any) {
        threwCode = e?.cause?.code ?? e?.message ?? "thrown"
      }
      assert.equal(attempts.length, c.expectRetry ? 2 : 1, c.id)
      assert.equal(threwCode, c.expectThrow ?? null, c.id)
      record(
        c.id,
        "docs",
        { method: c.method, host: new URL(c.url).host, path: new URL(c.url).pathname },
        {
          agentOptions,
          attempts: attempts.length,
          transports: attempts.map((a) => a.transport),
          sameBodyAcrossAttempts: attempts.length < 2 || JSON.stringify(attempts[0]?.body) === JSON.stringify(attempts[1]?.body),
          status,
          threwCode,
        },
      )
    }
  }

  const serialized = JSON.stringify(rows)
  for (const forbidden of [PAYER, OTHER_WALLET, JUPITER_V6, "BEGIN"]) {
    assert.ok(!serialized.includes(forbidden), `fixture leaked ${forbidden}`)
  }

  const outPath = join(import.meta.dir, "../test/fixtures/candle-presign-refused-source.json")
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        about:
          "Offline API pre-sign guard and fast-market stop-loss docs contracts (BE-3904, BE-4292, BE-4343, BE-4344) recorded from the published release commit 5d7a861a8 (CLI 0.13.47, MCP 0.10.45, SDK 0.6.39): Jupiter 6001 slippage_exceeded classification, inner-CPI exclusion, redaction, maxSlippageBps default (100) and cap (5,000), countRisk: false, and Fast markets and stop losses docs parity plus offline fastConnectFetch execution. The SDK, MCP and CLI package contracts live in candle-presign-refused-packages.json.",
        source,
        rows,
      },
      null,
      2,
    )}\n`,
  )
  console.log(`Recorded ${rows.length} offline presign-refused server/docs contracts from ${source.commit}.`)
} finally {
  globalThis.fetch = originalFetch
}
