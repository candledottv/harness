// Offline contracts for `hide` on perps orders in Candle's CLI, MCP server and SDK (BE-3996, the client half of
// BE-3769), read from an exact clean Candle source checkout: `--hide` / `hide` on perps open, close, modify and tpsl,
// and the fail-closed echo check (the order is refused, before anything is signed or sent, unless the API's build
// answers `hide: true`). The echo helpers of all three packages are run on a table of bodies; the SDK's open, close
// and modify are run over an intercepted fetch with a build that lacks the echo, and the requests they made are
// counted; the CLI's command table, the MCP tool shapes and the TP/SL attach are read as source text. Every fetch is
// intercepted. No key, wallet, venue or database is used, and the fixture holds no address, key or account value.
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
git("diff", "--exit-code", "HEAD", "--", "packages/cli/src", "packages/mcp/src", "packages/sdk/src")
const FILES = {
  cliPerps: "packages/cli/src/commands/perps.ts",
  cliPerpsManage: "packages/cli/src/commands/perps-manage.ts",
  cliManage: "packages/cli/src/hyperliquid-manage.ts",
  cliTrading: "packages/cli/src/trading.ts",
  mcpPerps: "packages/mcp/src/perps.ts",
  mcpManage: "packages/mcp/src/hyperliquid-manage.ts",
  mcpHide: "packages/mcp/src/hide.ts",
  sdkClient: "packages/sdk/src/client.ts",
  sdkManage: "packages/sdk/src/hyperliquid-manage.ts",
  sdkHide: "packages/sdk/src/hide-echo.ts",
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

  // 3. The clients as source text.
  const cliPerps = text(FILES.cliPerps), cliPerpsManage = text(FILES.cliPerpsManage), cliManage = text(FILES.cliManage), mcpPerps = text(FILES.mcpPerps), mcpManage = text(FILES.mcpManage)
  const sdkClient = text(FILES.sdkClient), sdkManage = text(FILES.sdkManage)
  const pin = (id: string, file: string, found: boolean) => rows.push({ id, scenario: "source-pin", args: { file }, outcome: { found } })
  const usage = (cmd: string) => new RegExp(`Usage: candle perps ${cmd}[^"\\n]*\\[--hide\\]`).test(cliPerps) || new RegExp(`Usage: candle perps ${cmd}[^"\\n]*\\[--hide\\]`).test(cliPerpsManage)
  for (const cmd of ["open", "close", "modify", "tpsl"]) pin(`cli-perps-${cmd}-usage-has-hide`, `${FILES.cliPerps} / ${FILES.cliPerpsManage}`, usage(cmd))
  pin("cli-perps-hide-boolean-flag", FILES.cliPerps, ((cliPerps + cliPerpsManage).match(/booleanFlags: [^\n]*"--hide"/g) ?? []).length === 4)
  pin("cli-write-refuses-an-unechoed-build-before-signing", FILES.cliPerps, /assertHideEchoed\(build, opts\.body\.hide === true, "perps build"\)/.test(cliPerps))
  pin("cli-tpsl-step-not-signed-without-the-echo", FILES.cliManage, /body\.hide === true && build\.hide !== true[\s\S]{0,260}?HIDE_NOT_CONFIRMED: the API did not echo hide: true\. This step was not signed\./.test(cliManage))
  pin("mcp-perps-tools-take-hide", FILES.mcpPerps, (mcpPerps.match(/hide: hideSchema,/g) ?? []).length === 4)
  pin("mcp-hide-only-on-open-close-modify-tpsl", FILES.mcpPerps, /\["candle_perps_open", "candle_perps_close", "candle_perps_modify", "candle_perps_tpsl"\]\.includes\(tool\)/.test(mcpPerps))
  pin("mcp-refuses-an-unechoed-build-before-the-relay", FILES.mcpPerps, /if \(hide && !hideEchoed\(build\)\)\s*return fail\("HIDE_NOT_CONFIRMED"/.test(mcpPerps))
  pin("mcp-tpsl-attach-carries-hide", FILES.mcpManage, /hide/.test(mcpManage))
  pin("sdk-open-close-modify-assert-the-echo", FILES.sdkClient, ["perpsOpen()", "perpsClose()", "perpsModify()"].every((m) => sdkClient.includes(`assertHideEchoed(hidden, build, "${m}")`)))
  pin("sdk-tpsl-passes-hide-to-the-attach", FILES.sdkClient, /\.\.\.\(hideRequested\(hide\) \? \{ hide: true \} : \{\}\),/.test(sdkClient))
  pin("sdk-tpsl-attach-checks-the-echo", FILES.sdkManage, /hide/.test(sdkManage))
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
  about: "Offline contracts for `hide` on perps orders in Candle's CLI, MCP server and SDK (BE-3996, the client half of BE-3769). echo rows run the three packages' echo helpers on one table of bodies; sdk-run rows run the SDK's open, close and modify over an intercepted fetch whose build lacks the `hide: true` echo and count what was requested; the rest are source text and the clients' facts. The fixture holds no address, key or account value; every fetch was intercepted and none reached the network.",
  source, rows,
}, null, 2)}\n`)
console.log(`Recorded ${rows.length} offline perps hide client contracts from ${source.commit}.`)
