// Offline contracts for `hide` on perps orders in Candle's CLI, MCP server and SDK (BE-3996, the client half of
// BE-3769), read from an exact clean Candle source checkout: `--hide` / `hide` on perps open, close, modify and tpsl,
// and the fail-closed echo check (the order is refused, before anything is signed or sent, unless the API's build
// answers `hide: true`). The echo helpers of all three packages are run on a table of bodies; the SDK's open, close
// and modify are run over an intercepted fetch with a build that lacks the echo, and the requests they made are
// counted; the shared TP/SL workflow (`runPerpsTpsl`, byte-identical across CLI, MCP and SDK) is run offline against
// a stand-in venue and builder for a hidden replacement (echoed), an unechoed attach refusal (attach never signed),
// and a remove-only plan; the CLI's command table, the MCP tool shapes and the package docs are read as source text.
// Every fetch is intercepted. No key, wallet, venue or database is used, and the fixture holds no address, key or
// account value.
//   bun scripts/read-perps-hide-source.ts <candle-monorepo checkout>
// The checkout needs its own dependencies installed.
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const checkout = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("usage: bun scripts/read-perps-hide-source.ts <candle-monorepo checkout>")
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`source git check failed: ${r.stderr}`)
  return r.stdout.trim()
}
git(
  "diff", "--exit-code", "HEAD", "--",
  "packages/cli/src", "packages/mcp/src", "packages/sdk/src",
  "docs/agent-trading.md", "packages/cli/README.md", "packages/mcp/README.md", "packages/sdk/README.md", "packages/sdk/CHANGELOG.md",
)
const FILES = {
  cliPerps: "packages/cli/src/commands/perps.ts",
  cliPerpsManage: "packages/cli/src/commands/perps-manage.ts",
  cliManage: "packages/cli/src/hyperliquid-manage.ts",
  cliTrading: "packages/cli/src/trading.ts",
  mcpPerps: "packages/mcp/src/perps.ts",
  mcpManage: "packages/mcp/src/hyperliquid-manage.ts",
  mcpHide: "packages/mcp/src/hide.ts",
  sdkClient: "packages/sdk/src/client.ts",
  sdkHyperliquid: "packages/sdk/src/hyperliquid.ts",
  sdkManage: "packages/sdk/src/hyperliquid-manage.ts",
  sdkHide: "packages/sdk/src/hide-echo.ts",
  agentTradingDoc: "docs/agent-trading.md",
  cliReadme: "packages/cli/README.md",
  mcpReadme: "packages/mcp/README.md",
  sdkReadme: "packages/sdk/README.md",
  sdkChangelog: "packages/sdk/CHANGELOG.md",
}
const source = {
  repo: "candledottv/candle-monorepo", commit: git("rev-parse", "HEAD"),
  versions: Object.fromEntries(["cli", "mcp", "sdk"].map((p) => [p, JSON.parse(readFileSync(join(checkout, "packages", p, "package.json"), "utf8")).version])),
  files: Object.values(FILES),
}
const text = (path: string) => readFileSync(join(checkout, path), "utf8")
const load = (path: string) => import(pathToFileURL(join(checkout, path)).href)

const originalFetch = globalThis.fetch
const network: string[] = []
globalThis.fetch = (async (input: unknown) => { network.push(String(input)); throw new Error("the recording may not reach the network") }) as unknown as typeof fetch

type Row = { id: string; scenario: string; args: Record<string, unknown>; outcome: unknown }
const rows: Row[] = []
try {
  // 1. The echo helpers, run on bodies: only `hide: true` counts (the CLI also takes the stored name `streamHidden`).
  const sdkHide = await load(FILES.sdkHide)
  const mcpHide = await load(FILES.mcpHide)
  const cliTrading = await load(FILES.cliTrading)
  const bodies: Array<[string, unknown]> = [
    ["hide-true", { hide: true }],
    ["stream-hidden-true", { streamHidden: true }],
    ["hide-false", { hide: false }],
    ["hide-string-true", { hide: "true" }],
    ["hide-one", { hide: 1 }],
    ["no-key", { success: true }],
    ["null", null],
    ["array", [{ hide: true }]],
    ["text", "hide"],
  ]
  const sdkEchoes = (body: unknown) => { try { sdkHide.assertHideEchoed(true, body, "perpsOpen()"); return true } catch (e) { assert.equal((e as { code?: string }).code, "HIDE_NOT_CONFIRMED"); return false } }
  const cliEchoes = (body: unknown) => { try { cliTrading.assertHideEchoed(body, true); return true } catch (e) { assert.equal((e as { code?: string }).code, "HIDE_NOT_CONFIRMED"); return false } }
  for (const [id, body] of bodies) {
    rows.push({ id: `echo-${id}`, scenario: "echo", args: { body: body === undefined ? null : body }, outcome: { cli: cliEchoes(body), mcp: mcpHide.hideEchoed(body), sdk: sdkEchoes(body) } })
  }
  // Not asked: nothing is checked, whatever the body says.
  rows.push({ id: "echo-not-asked-checks-nothing", scenario: "echo", args: { asked: false }, outcome: { sdk: (() => { sdkHide.assertHideEchoed(false, { success: true }, "perpsOpen()"); return "no refusal" })(), cli: (() => { cliTrading.assertHideEchoed({ success: true }, false); return "no refusal" })() } })
  rows.push({ id: "echo-refusal-words", scenario: "echo", args: {}, outcome: {
    cliCode: (() => { try { cliTrading.assertHideEchoed({}, true, "perps build") } catch (e) { return { code: (e as { code: string }).code, says: /Nothing was signed or sent by this check/.test((e as Error).message), warnsNotHidden: /if an order was already placed it is NOT hidden/.test((e as Error).message) } } })(),
    mcpSays: /so the order may have been placed publicly/.test(mcpHide.hideNotConfirmedMessage("candle_perps_open")),
    sdkRetryable: (() => { try { sdkHide.assertHideEchoed(true, {}, "x") } catch (e) { return (e as { retryable: boolean }).retryable } })(),
  } })

  // 2. The SDK, run: a hidden open, close or modify whose build lacks the echo is refused after the one build
  // request, with the venue, the relay and the exchange never reached.
  const { CandleClient } = await load(FILES.sdkClient)
  const BUILDER = "0x7a2b3c4d5e6f708192a3b4c5d6e7f80910a1b2c3"
  const WALLET = "wallet-fixture"
  const CLOID = `0x${"1".repeat(32)}`
  const buildWithoutEcho = { success: true, perpOrderId: "perp-fixture", kind: "open", network: "mainnet", walletId: WALLET, cloid: CLOID }
  const sdkCases: Array<[string, string, Record<string, unknown>, string]> = [
    ["open", "perpsOpen", { walletId: WALLET, coin: "BTC", side: "long", size: "0.01", hide: true }, "/api/v1/agent/perps/open"],
    ["close", "perpsClose", { walletId: WALLET, coin: "BTC", size: "0.5", hide: true }, "/api/v1/agent/perps/close"],
    ["modify", "perpsModify", { walletId: WALLET, cloid: CLOID, price: "60000", hide: true }, "/api/v1/agent/perps/modify"],
  ]
  for (const [id, method, params, path] of sdkCases) {
    const calls: Array<{ path: string; body: unknown }> = []
    const client = new CandleClient({
      apiUrl: "https://api.fixture.test", apiKey: "fixture-key", hyperliquidBuilder: BUILDER, maxRetries: 0,
      fetch: (async (input: unknown, init?: RequestInit) => {
        calls.push({ path: String(input).replace("https://api.fixture.test", ""), body: init?.body ? JSON.parse(String(init.body)) : null })
        return new Response(JSON.stringify(buildWithoutEcho), { status: 200, headers: { "content-type": "application/json" } })
      }) as unknown as typeof fetch,
    })
    let refused: { code?: string; status?: number } | null = null
    try { await client[method](params) } catch (e) { refused = { code: (e as { code?: string }).code, status: (e as { status?: number }).status } }
    assert.equal(calls.length, 1, `${id}: the SDK made more than the one build request`)
    assert.equal(calls[0]!.path, path)
    rows.push({ id: `sdk-${id}-without-echo-is-refused`, scenario: "sdk-run", args: { method, hide: true, buildEchoesHide: false }, outcome: { refused, requests: calls.map((c) => ({ path: c.path, sendsHide: (c.body as { hide?: unknown }).hide === true })) } })
  }
  {
    // Asked without hide: the body carries no `hide` key at all.
    const calls: Array<{ body: Record<string, unknown> }> = []
    const client = new CandleClient({
      apiUrl: "https://api.fixture.test", apiKey: "fixture-key", hyperliquidBuilder: BUILDER, maxRetries: 0,
      fetch: (async (_input: unknown, init?: RequestInit) => { calls.push({ body: JSON.parse(String(init?.body)) }); return new Response(JSON.stringify({ success: false }), { status: 400, headers: { "content-type": "application/json" } }) }) as unknown as typeof fetch,
    })
    for (const hide of [false, undefined]) { try { await client.perpsOpen({ walletId: WALLET, coin: "BTC", side: "long", size: "0.01", ...(hide === undefined ? {} : { hide }) }) } catch {} }
    rows.push({ id: "sdk-open-without-hide-sends-no-hide-key", scenario: "sdk-run", args: { hide: "false or omitted" }, outcome: { bodiesWithAHideKey: calls.filter((c) => "hide" in c.body).length, requests: calls.length } })
  }

  // 3. The shared TP/SL workflow (`runPerpsTpsl`, byte-identical across CLI, MCP and SDK), run offline against a
  // stand-in venue and builder: cancel never sends `hide`, attach sends `hide: true` and refuses to sign when the
  // build lacks the echo, and remove-only completes with one plain cancel build.
  const { hyperliquidActionHash, hyperliquidL1TypedData } = await load(FILES.sdkHyperliquid)
  const { runPerpsTpsl } = await load(FILES.sdkManage)
  const VENUE_ADDRESS = "0x14791697260e4c9a71f18484c9f997b308e59325"
  const SIGNATURE = `0x${"a".repeat(64)}${"b".repeat(64)}1c`
  const UNIVERSE = [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }]
  const MARKS = ["60000"]

  async function runTpslFixture(opts: { existingLeg: "tp" | "sl"; existingPx: string; params: Record<string, unknown>; echoAttachHide: boolean }) {
    const trackedCloid = `0x${"c".repeat(32)}`
    let orders: Array<{ coin: string; oid: number; cloid: string | null; side: "A" | "B"; sz: string; limitPx: string; reduceOnly: boolean; isTrigger: boolean; triggerPx: string; orderType: string }> = [
      {
        coin: "BTC", oid: 500, cloid: trackedCloid, side: "A", sz: "0.5", limitPx: opts.existingPx,
        reduceOnly: true, isTrigger: true, triggerPx: opts.existingPx,
        orderType: opts.existingLeg === "tp" ? "Take Profit Market" : "Stop Market",
      },
    ]
    const builds: Array<{ path: string; operation: unknown; hasHideKey: boolean; hide: unknown }> = []
    let signs = 0
    let nonce = 1_790_000_000_000
    let counter = 0
    let nextOid = 1000
    const json = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) })
    const stamp = (action: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      nonce++
      return {
        success: true, perpOrderId: `perp-${nonce}`, walletId: WALLET, address: VENUE_ADDRESS, network: "mainnet", nonce, action,
        typedData: hyperliquidL1TypedData(hyperliquidActionHash(action, nonce), "mainnet"),
        ...extra,
      }
    }
    const io = {
      network: "mainnet", walletId: WALLET, address: VENUE_ADDRESS, builder: BUILDER, keyReduceOnly: false,
      now: () => 1_790_000_000_000, mode: "submit",
      cloid: () => `0x${(++counter).toString(16).padStart(32, "0")}`,
      sign: async () => { signs++; return SIGNATURE },
      fetcher: async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"))
        if (url.endsWith("/info")) {
          if (body.type === "metaAndAssetCtxs") return json([{ universe: UNIVERSE }, MARKS.map((markPx) => ({ markPx }))])
          if (body.type === "meta") return json({ universe: UNIVERSE })
          if (body.type === "clearinghouseState") return json({ assetPositions: [{ position: { coin: "BTC", szi: "0.5", leverage: { type: "cross", value: 10 } } }] })
          if (body.type === "frontendOpenOrders") return json(orders)
          throw new Error(`unexpected info ${body.type}`)
        }
        const action = body.action as Record<string, unknown>
        if (action.type === "cancel") {
          const target = (action.cancels as Array<{ o: number }>)[0]?.o
          orders = orders.filter((o) => o.oid !== target)
          return json({ status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } })
        }
        const order = (action.orders as Array<Record<string, unknown>>)[0]!
        const trigger = (order.t as { trigger: { triggerPx: string; tpsl: string } }).trigger
        orders.push({
          coin: "BTC", oid: nextOid++, cloid: String(order.c), side: order.b ? "B" : "A", sz: String(order.s), limitPx: String(order.p),
          reduceOnly: true, isTrigger: true, triggerPx: trigger.triggerPx,
          orderType: trigger.tpsl === "tp" ? "Take Profit Market" : "Stop Market",
        })
        return json({ status: "ok", response: { type: "order", data: { statuses: ["waitingForTrigger"] } } })
      },
      read: async () => ({
        coin: "BTC",
        tracked: orders.filter((o) => o.cloid === trackedCloid).map((o) => ({ leg: o.orderType.startsWith("Take") ? "tp" : "sl", oid: o.oid, cloid: o.cloid, triggerPx: o.triggerPx })),
        unowned: [],
      }),
      build: async (path: string, body: Record<string, unknown>) => {
        builds.push({ path, operation: body.operation, hasHideKey: "hide" in body, hide: body.hide ?? null })
        if (body.operation === "cancel") {
          const target = orders.find((o) => o.cloid === body.targetCloid)
          assert.ok(target, "cancel target must be open")
          return stamp({ type: "cancel", cancels: [{ a: 0, o: target.oid }] })
        }
        const cloid = `0x${(++counter).toString(16).padStart(32, "0")}`
        const triggerPx = String(body.triggerPx)
        const action = {
          type: "order",
          orders: [{ a: 0, b: false, p: triggerPx, s: "0.5", r: true, t: { trigger: { isMarket: true, triggerPx, tpsl: String(body.leg) } }, c: cloid }],
          grouping: "positionTpsl",
        }
        return stamp(action, { cloid, clientId: cloid, ...(opts.echoAttachHide && body.hide === true ? { hide: true } : {}) })
      },
    }
    const result = await runPerpsTpsl(io, opts.params)
    return {
      complete: result.complete,
      signs,
      builds,
      steps: result.steps.map((s: { kind: string; status: string; detail?: string }) => ({ kind: s.kind, status: s.status, ...(s.detail ? { detail: s.detail } : {}) })),
      remainingTriggerPx: orders.map((o) => o.triggerPx),
    }
  }

  rows.push({
    id: "sdk-tpsl-hidden-replacement-echoed",
    scenario: "tpsl-run",
    args: { coin: "BTC", stopLoss: "56000", hide: true, echoAttachHide: true },
    outcome: await runTpslFixture({ existingLeg: "sl", existingPx: "55000", params: { coin: "BTC", stopLoss: "56000", hide: true }, echoAttachHide: true }),
  })
  rows.push({
    id: "sdk-tpsl-hidden-attach-without-echo-refused",
    scenario: "tpsl-run",
    args: { coin: "BTC", takeProfit: "66000", hide: true, echoAttachHide: false },
    outcome: await runTpslFixture({ existingLeg: "tp", existingPx: "67000", params: { coin: "BTC", takeProfit: "66000", hide: true }, echoAttachHide: false }),
  })
  rows.push({
    id: "sdk-tpsl-remove-only-with-hide-uses-plain-cancel",
    scenario: "tpsl-run",
    args: { coin: "BTC", removeSl: true, hide: true },
    outcome: await runTpslFixture({ existingLeg: "sl", existingPx: "55000", params: { coin: "BTC", removeSl: true, hide: true }, echoAttachHide: false }),
  })

  // 4. The clients and package docs as source text.
  const cliPerps = text(FILES.cliPerps), cliPerpsManage = text(FILES.cliPerpsManage), cliManage = text(FILES.cliManage), mcpPerps = text(FILES.mcpPerps), mcpManage = text(FILES.mcpManage)
  const sdkClient = text(FILES.sdkClient), sdkManage = text(FILES.sdkManage)
  const agentTradingDoc = text(FILES.agentTradingDoc), cliReadme = text(FILES.cliReadme), mcpReadme = text(FILES.mcpReadme), sdkReadme = text(FILES.sdkReadme), sdkChangelog = text(FILES.sdkChangelog)
  const pin = (id: string, file: string, found: boolean) => rows.push({ id, scenario: "source-pin", args: { file }, outcome: { found } })
  const usage = (cmd: string) => new RegExp(`Usage: candle perps ${cmd}[^"\\n]*\\[--hide\\]`).test(cliPerps) || new RegExp(`Usage: candle perps ${cmd}[^"\\n]*\\[--hide\\]`).test(cliPerpsManage)
  for (const cmd of ["open", "close", "modify", "tpsl"]) pin(`cli-perps-${cmd}-usage-has-hide`, `${FILES.cliPerps} / ${FILES.cliPerpsManage}`, usage(cmd))
  pin("cli-perps-hide-boolean-flag", FILES.cliPerps, ((cliPerps + cliPerpsManage).match(/booleanFlags: [^\n]*"--hide"/g) ?? []).length === 4)
  pin("cli-write-refuses-an-unechoed-build-before-signing", FILES.cliPerps, /assertHideEchoed\(build, opts\.body\.hide === true, "perps build"\)/.test(cliPerps))
  pin("cli-tpsl-step-not-signed-without-the-echo", FILES.cliManage, /body\.hide === true && build\.hide !== true[\s\S]{0,260}?HIDE_NOT_CONFIRMED: the API did not echo hide: true\. This step was not signed\./.test(cliManage))
  pin("manage-helpers-identical-across-cli-mcp-sdk", `${FILES.cliManage} / ${FILES.mcpManage} / ${FILES.sdkManage}`, cliManage === sdkManage && mcpManage === sdkManage)
  const mcpToolBlock = (name: string) => {
    const s = mcpPerps.indexOf(`${name}: {`)
    if (s < 0) return ""
    return mcpPerps.slice(s, mcpPerps.indexOf("\n  },", s))
  }
  const perpsHideTools = ["candle_perps_open", "candle_perps_close", "candle_perps_modify", "candle_perps_tpsl"]
  pin("mcp-perps-tools-take-hide", FILES.mcpPerps, perpsHideTools.every((t) => /hide: hideSchema,/.test(mcpToolBlock(t))))
  const mcpHideGuard = mcpPerps.match(/isHideFlag\(hideArg\) &&\s*\[([\s\S]*?)\]\.includes\(tool\)/)?.[1] ?? ""
  pin("mcp-hide-on-perps-open-close-modify-tpsl", FILES.mcpPerps, perpsHideTools.every((t) => mcpHideGuard.includes(`"${t}"`)) && !mcpHideGuard.includes("candle_perps_cancel") && !mcpHideGuard.includes("candle_perps_flatten"))
  pin("mcp-refuses-an-unechoed-build-before-the-relay", FILES.mcpPerps, /if \(hide && !hideEchoed\(build\)\)\s*return fail\("HIDE_NOT_CONFIRMED"/.test(mcpPerps))
  pin("mcp-tpsl-attach-carries-hide", FILES.mcpManage, /params\.hide === true \? \{ hide: true \} : \{\}/.test(mcpManage))
  pin("sdk-open-close-modify-assert-the-echo", FILES.sdkClient, ["perpsOpen()", "perpsClose()", "perpsModify()"].every((m) => sdkClient.includes(`assertHideEchoed(hidden, build, "${m}")`)))
  pin("sdk-tpsl-passes-hide-to-the-attach", FILES.sdkClient, /\.\.\.\(hideRequested\(hide\) \? \{ hide: true \} : \{\}\),/.test(sdkClient))
  pin("sdk-tpsl-attach-checks-the-echo", FILES.sdkManage, /body\.hide === true && build\.hide !== true/.test(sdkManage))
  pin("docs-agent-trading-covers-perps-hide-and-echo", FILES.agentTradingDoc, /Hiding a perps order/.test(agentTradingDoc) && /candle perps open\|close\|modify\|tpsl/.test(agentTradingDoc) && /HIDE_NOT_CONFIRMED/.test(agentTradingDoc))
  pin("docs-package-readmes-and-changelog-cover-perps-hide", `${FILES.cliReadme} / ${FILES.mcpReadme} / ${FILES.sdkReadme} / ${FILES.sdkChangelog}`,
    /Hiding Hyperliquid perps orders/.test(cliReadme) && /candle perps open/.test(cliReadme) && /HIDE_NOT_CONFIRMED/.test(cliReadme) &&
    /Hiding Hyperliquid perps orders/.test(mcpReadme) && /candle_perps_open/.test(mcpReadme) && /HIDE_NOT_CONFIRMED/.test(mcpReadme) &&
    /perpsOpen\(\)/.test(sdkReadme) && /HIDE_NOT_CONFIRMED/.test(sdkReadme) &&
    /`perpsOpen`, `perpsClose`, `perpsModify` and `perpsTpsl`/.test(sdkChangelog) && /HIDE_NOT_CONFIRMED/.test(sdkChangelog))
  const sdkParams = sdkClient.slice(sdkClient.indexOf("export interface PerpsOpenParams"), sdkClient.indexOf("export interface PerpsLeverageParams"))
  const tpslParams = (() => { const s = sdkManage.indexOf("export interface PerpsTpslParams"); return sdkManage.slice(s, sdkManage.indexOf("\n}\n", s)) })()
  rows.push({ id: "clients-carry-perps-hide", scenario: "clients", args: { files: Object.values(FILES) }, outcome: {
    cliPerpsTakesHide: /--hide/.test(cliPerps + cliPerpsManage), mcpPerpsTakesHide: /\bhide\b/.test(mcpPerps), mcpManageTakesHide: /\bhide\b/.test(mcpManage),
    sdkOpenCloseModifyTakeHide: /\bhide\b/.test(sdkParams), sdkTpslTakesHide: /\bhide\b/.test(tpslParams),
  } })
  for (const r of rows.filter((r) => r.scenario === "source-pin")) assert.equal((r.outcome as { found: boolean }).found, true, `${r.id}: not found in ${(r.args as { file: string }).file}`)
} finally { globalThis.fetch = originalFetch }

assert.deepEqual(network, [], `the recording reached for ${network.join(", ")}`)
assert.ok(!/0x[0-9a-fA-F]{40}\b/.test(JSON.stringify(rows)), "a fixture carries an address")
writeFileSync(join(import.meta.dir, "../test/fixtures/candle-perps-hide-source.json"), `${JSON.stringify({
  about: "Offline contracts for `hide` on perps orders in Candle's CLI, MCP server and SDK (BE-3996, the client half of BE-3769). echo rows run the three packages' echo helpers on one table of bodies; sdk-run rows run the SDK's open, close and modify over an intercepted fetch whose build lacks the `hide: true` echo and count what was requested; tpsl-run rows run the shared TP/SL workflow (`runPerpsTpsl`, byte-identical across CLI, MCP and SDK) offline against a stand-in venue and builder for a hidden replacement, an unechoed attach refusal (attach never signed) and a remove-only plan; the rest are source text, docs pins and the clients' facts. The fixture holds no address, key or account value; every fetch was intercepted and none reached the network.",
  source, rows,
}, null, 2)}\n`)
console.log(`Recorded ${rows.length} offline perps hide client contracts from ${source.commit}.`)
