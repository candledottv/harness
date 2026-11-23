// Offline pre-sign build refusal (`reason: "presign_refused"`) and stop-loss retry run (BE-4292, BE-4293, BE-4342,
// BE-4345) through the PUBLISHED npm packages, not a monorepo checkout:
//   - `@candledottv/agent-sdk` (0.6.39 main entry): `CandleApiError` carrying `refusal` and `detail` alongside
//     `reason`, `stage`, `retryable` and `requestId`, `CandleClient.buildTrade()` and `CandleClient.trade()` (keeping
//     `clientTradeId` and stopping before reading any signer key), immediate rebuilds on `retryable: true` under the
//     same `clientTradeId` or a new `clientTradeId` with wider `maxSlippageBps`, plus the shipped `README.md` and
//     `dist/errors.d.ts` declarations;
//   - `@candledottv/mcp` (0.10.45 `bin.candle-mcp`): `candle_trade` and `candle_swap` relaying `presign_refused`
//     envelopes with `refusal`, `detail` and `cause: "slippage_exceeded"`;
//   - `@candledottv/cli` (0.13.47 `bin.candle`): `candle swap --yes --json` exiting 1 with `SWAP_FAILED` before
//     signing when `POST /api/v1/trade/agent/build` returns `presign_refused`.
// The pinned versions in `scripts/presign-refused-packages.json` are installed fresh from the npm registry when no
// `<dir>` is passed (the only network use), then every Candle API and RPC call is answered offline in memory.
//   bun scripts/run-presign-refused-packages.ts            installs the pins into a temp dir, writes the fixture
//   bun scripts/run-presign-refused-packages.ts <dir>      reuses a dir that already holds the pinned install
import { strict as assert } from "node:assert"
import { generateKeyPairSync } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const pins = JSON.parse(readFileSync(join(import.meta.dir, "presign-refused-packages.json"), "utf8")) as Record<string, string>
const PRELOAD = join(import.meta.dir, "presign-refused-preload.ts")

const workDir = mkdtempSync(join(tmpdir(), "presign-refused-pkgs-"))
const installDir = process.argv[2] ? resolve(process.argv[2]) : join(workDir, "install")

const API = "https://api.test"
const KEY = "fixture-only-not-a-key"
const PAYER = "7ZL9FvkpCMgdvzfoMSYZSuCXLCYN25dfgtDXej1BBJaB"
const MINT = "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL"
const KEYRING_PASSPHRASE = "fixture-passphrase-not-secret"

const SLIPPAGE_DETAIL =
  'The price moved past maxSlippageBps before the transaction could land; retry at once for a fresh quote, or raise maxSlippageBps (default 100, cap 5000). ({"InstructionError":[3,{"Custom":6001}]}; Program <redacted> failed: custom program error: 0x1771)'

const PRESIGN_SLIPPAGE_ENVELOPE = {
  success: false,
  error: {
    code: "SWAP_FAILED",
    message: "The built transaction failed the pre-sign safety check (simulation_failed); nothing was signed or sent.",
    retryable: true,
    stage: "not_broadcast",
    reason: "presign_refused",
    refusal: "simulation_failed",
    detail: SLIPPAGE_DETAIL,
    cause: "slippage_exceeded",
  },
}

type WireCall = { n: number; method: string; host: string; path: string; rpc?: string; clientTradeId?: string; maxSlippageBps?: number }
type Row = {
  id: string
  scenario: "sdk-envelope" | "sdk-client" | "mcp-package" | "cli-package" | "package-docs"
  surface: "sdk" | "mcp" | "cli" | "docs"
  args: Record<string, unknown>
  requests?: WireCall[]
  outcome: Record<string, unknown>
}
const rows: Row[] = []
const record = (
  id: string,
  scenario: Row["scenario"],
  surface: Row["surface"],
  args: Record<string, unknown>,
  outcome: Record<string, unknown>,
  requests?: WireCall[],
) => rows.push({ id, scenario, surface, args, ...(requests ? { requests } : {}), outcome })

const scrub = (s: string) => s.replaceAll(PAYER, "<payer>").replaceAll(MINT, "<mint>").replaceAll(KEY, "<key>").replaceAll(workDir, "<tmp>")

const originalFetch = globalThis.fetch
try {
  if (!process.argv[2]) {
    mkdirSync(installDir, { recursive: true })
    writeFileSync(join(installDir, "package.json"), `${JSON.stringify({ name: "presign-refused-published", private: true, type: "module" })}\n`)
    const add = Bun.spawnSync([process.execPath, "add", "--exact", ...Object.entries(pins).map(([n, v]) => `${n}@${v}`)], {
      cwd: installDir,
      stderr: "pipe",
      stdout: "pipe",
    })
    if (add.exitCode !== 0) throw new Error(`install of the pinned packages failed: ${add.stderr.toString()}`)
  }

  // Lock out direct network access in this process once packages are present on disk.
  globalThis.fetch = (() => {
    throw new Error("presign-refused package recording may not access the network")
  }) as unknown as typeof fetch

  const pkgDir = (name: string) => join(installDir, "node_modules", name)
  const manifest = (name: string) => JSON.parse(readFileSync(join(pkgDir(name), "package.json"), "utf8"))
  const lockText = existsSync(join(installDir, "bun.lock")) ? readFileSync(join(installDir, "bun.lock"), "utf8") : ""
  const packages = Object.fromEntries(
    Object.entries(pins).map(([name, version]) => {
      assert.equal(manifest(name).version, version, `${name} must be installed at the pinned ${version}`)
      const integrity = lockText.match(new RegExp(`"${name}@${version.replace(/\./g, "\\.")}", "[^"]*", [^\\n]*?"(sha512-[^"]+)"`))?.[1]
      return [name, { version, ...(integrity ? { integrity } : {}) }]
    }),
  )

  const sdkManifest = manifest("@candledottv/agent-sdk")
  const mcpManifest = manifest("@candledottv/mcp")
  const cliManifest = manifest("@candledottv/cli")
  const SDK_ENTRY = join(pkgDir("@candledottv/agent-sdk"), sdkManifest.main)
  const MCP_ENTRY = join(pkgDir("@candledottv/mcp"), mcpManifest.bin["candle-mcp"])
  const CLI_ENTRY = join(pkgDir("@candledottv/cli"), cliManifest.bin.candle)

  const sdk = await import(pathToFileURL(SDK_ENTRY).href)
  const { CandleClient, CandleApiError, REQUEST_ID_HEADER, requestIdOf } = sdk
  assert.equal(typeof CandleClient, "function", "@candledottv/agent-sdk exports CandleClient")
  assert.equal(typeof CandleApiError, "function", "@candledottv/agent-sdk exports CandleApiError")
  assert.equal(REQUEST_ID_HEADER, "x-candle-request-id")
  assert.equal(typeof requestIdOf, "function")

  // Throwaway encrypted signer store for the shipped CLI swap run (never leaves `workDir`, never signs).
  const configDir = join(workDir, "config")
  {
    mkdirSync(configDir, { recursive: true, mode: 0o700 })
    const pem = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    const stored = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "")
    const iterations = 1000
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(KEYRING_PASSPHRASE), "PBKDF2", false, ["deriveKey"])
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt"])
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(stored)))
    const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64")
    writeFileSync(
      join(configDir, "credentials.enc"),
      JSON.stringify({ wallet_signer_lw_1: { salt: b64(salt), iv: b64(iv), ciphertext: b64(ciphertext), iterations } }),
      { mode: 0o600 },
    )
  }

  // 1. Published `@candledottv/agent-sdk@0.6.39` envelope parsing via `CandleClient.buildTrade()`.
  {
    const cases: { id: string; status: number; body: string; requestId?: string; wireCause?: string }[] = [
      {
        id: "sdk-pkg-slippage-refused",
        status: 500,
        body: JSON.stringify(PRESIGN_SLIPPAGE_ENVELOPE),
        requestId: "req_fixture_064152",
        wireCause: "slippage_exceeded",
      },
      {
        id: "sdk-pkg-fee-mismatch",
        status: 500,
        body: JSON.stringify({
          success: false,
          error: {
            code: "SWAP_FAILED",
            message: "The built transaction failed the pre-sign safety check (fee_amount_mismatch); nothing was signed or sent.",
            retryable: true,
            stage: "not_broadcast",
            reason: "presign_refused",
            refusal: "fee_amount_mismatch",
            detail: "expected fee 50000 lamports, simulated transfer 48500 lamports",
          },
        }),
      },
      {
        id: "sdk-pkg-insufficient-lamports",
        status: 400,
        body: JSON.stringify({
          success: false,
          error: {
            code: "INSUFFICIENT_OWNER_BALANCE",
            message: "The paying wallet <payer> does not hold enough SOL for this sell; nothing was signed or sent.",
            retryable: false,
            stage: "not_broadcast",
            reason: "presign_refused",
            refusal: "simulation_failed",
            detail: "Transfer: insufficient lamports 900000, need 2039280",
          },
        }),
      },
      {
        id: "sdk-pkg-no-presign-fields",
        status: 403,
        body: JSON.stringify({
          success: false,
          error: { code: "SPEND_LIMIT_EXCEEDED", message: "Exceeds per-trade spend cap.", retryable: false },
        }),
      },
      {
        id: "sdk-pkg-non-string-ignored",
        status: 500,
        body: JSON.stringify({
          success: false,
          error: {
            code: "SWAP_FAILED",
            message: "Refused.",
            retryable: true,
            stage: "not_broadcast",
            reason: "presign_refused",
            refusal: 6001,
            detail: { nested: true },
          },
        }),
      },
      {
        id: "sdk-pkg-non-json-502",
        status: 502,
        body: "Bad Gateway",
        requestId: "req_proxy_502_abcd",
      },
    ]

    for (const c of cases) {
      const headers: Record<string, string> = {
        "content-type": c.body.startsWith("{") ? "application/json" : "text/plain",
        ...(c.requestId ? { [REQUEST_ID_HEADER]: c.requestId } : {}),
      }
      const client = new CandleClient({
        apiUrl: API,
        apiKey: KEY,
        maxRetries: 0,
        fetch: (async () => new Response(c.body, { status: c.status, headers })) as unknown as typeof fetch,
      })
      let err: any
      try {
        await client.buildTrade({
          clientTradeId: `env-${c.id}`,
          mint: MINT,
          side: "sell",
          amountRaw: "91598938670",
          payer: { type: "main" },
        })
      } catch (e) {
        err = e
      }
      assert.ok(err instanceof CandleApiError, `${c.id} threw CandleApiError`)
      record(
        c.id,
        "sdk-envelope",
        "sdk",
        { status: c.status, hasRequestId: c.requestId !== undefined, ...(c.wireCause ? { wireCause: c.wireCause } : {}) },
        {
          code: err.code,
          status: err.status,
          retryable: err.retryable,
          stage: err.stage ?? null,
          reason: err.reason ?? null,
          refusal: err.refusal ?? null,
          detail: err.detail ?? null,
          requestId: err.requestId ?? null,
          message: scrub(String(err.message)),
        },
      )
    }
  }

  // 2. Published `@candledottv/agent-sdk@0.6.39` `buildTrade()`, `trade()`, and immediate stop-loss rebuilds.
  {
    const builtOk = (clientTradeId: string, maxSlippageBps: number) => ({
      status: "built",
      chain: "solana",
      clientTradeId,
      walletAddress: PAYER,
      artifacts: {
        quoteAsset: "sol",
        amountRaw: "91598938670",
        expectedOutRaw: "1980000",
        minOutRaw: String(Math.floor((1_980_000 * (10_000 - maxSlippageBps)) / 10_000)),
        fee: { bps: 50, feeRaw: "9900" },
        expiresAt: 1_795_000_060_000,
        venue: "pump",
        priceImpactPct: "1.2",
        tokenRisks: [],
        transactionBase64: Buffer.alloc(64, 1).toString("base64"),
      },
    })

    // 2a. `buildTrade()` throws `CandleApiError` with `refusal`, `detail` and `requestId` after one POST.
    {
      const calls: WireCall[] = []
      const client = new CandleClient({
        apiUrl: API,
        apiKey: KEY,
        fetch: (async (input: string | URL, init?: RequestInit) => {
          const u = new URL(String(input))
          const body = init?.body ? JSON.parse(String(init.body)) : {}
          calls.push({
            n: calls.length + 1,
            method: init?.method ?? "GET",
            host: u.host,
            path: u.pathname,
            clientTradeId: body.clientTradeId,
            maxSlippageBps: body.maxSlippageBps,
          })
          return new Response(JSON.stringify(PRESIGN_SLIPPAGE_ENVELOPE), {
            status: 500,
            headers: { "content-type": "application/json", [REQUEST_ID_HEADER]: "req_build_refused_1" },
          })
        }) as unknown as typeof fetch,
      })
      let caught: any
      try {
        await client.buildTrade({
          clientTradeId: "stop-sell-1",
          mint: MINT,
          side: "sell",
          amountRaw: "91598938670",
          payer: { type: "linked", linkedWalletId: "lw_fixture_1" },
        })
      } catch (e) {
        caught = e
      }
      assert.ok(caught instanceof CandleApiError)
      assert.equal(calls.length, 1)
      assert.equal(caught.refusal, "simulation_failed")
      assert.equal(caught.detail, SLIPPAGE_DETAIL)
      assert.equal(caught.requestId, "req_build_refused_1")
      record(
        "sdk-pkg-build-trade-presign-refused",
        "sdk-client",
        "sdk",
        { method: "buildTrade", side: "sell", clientTradeId: "stop-sell-1" },
        {
          threw: caught.name,
          code: caught.code,
          status: caught.status,
          retryable: caught.retryable,
          stage: caught.stage,
          reason: caught.reason,
          refusal: caught.refusal,
          detail: caught.detail,
          requestId: caught.requestId,
          clientTradeId: caught.clientTradeId ?? null,
        },
        calls,
      )
    }

    // 2b. `trade()` preserves `refusal`, `detail` AND `clientTradeId`, stopping before reading any signer key.
    {
      const calls: WireCall[] = []
      let signed = 0
      const client = new CandleClient({
        apiUrl: API,
        apiKey: KEY,
        maxRetries: 0,
        privyAppId: "privy-fixture-app",
        secretStore: {
          getSignerPrivateKeyPem: async () => {
            signed++
            throw new Error("presign_refused must stop before reading signer key")
          },
        } as never,
        fetch: (async (input: string | URL, init?: RequestInit) => {
          const u = new URL(String(input))
          const body = init?.body ? JSON.parse(String(init.body)) : {}
          calls.push({
            n: calls.length + 1,
            method: init?.method ?? "GET",
            host: u.host,
            path: u.pathname,
            clientTradeId: body.clientTradeId,
          })
          return new Response(JSON.stringify(PRESIGN_SLIPPAGE_ENVELOPE), {
            status: 500,
            headers: { "content-type": "application/json", [REQUEST_ID_HEADER]: "req_onecall_refused_1" },
          })
        }) as unknown as typeof fetch,
      })
      let caught: any
      try {
        await client.trade({
          clientTradeId: "stop-sell-onecall",
          mint: MINT,
          side: "sell",
          amountRaw: "91598938670",
          from: { linkedWalletId: "lw_fixture_1", privyWalletId: "pw_fixture_1" },
        })
      } catch (e) {
        caught = e
      }
      assert.ok(caught instanceof CandleApiError)
      assert.equal(signed, 0)
      assert.equal(caught.clientTradeId, "stop-sell-onecall")
      assert.equal(caught.refusal, "simulation_failed")
      assert.equal(caught.detail, SLIPPAGE_DETAIL)
      record(
        "sdk-pkg-one-call-trade-presign-refused",
        "sdk-client",
        "sdk",
        { method: "trade", side: "sell", clientTradeId: "stop-sell-onecall" },
        {
          threw: caught.name,
          code: caught.code,
          status: caught.status,
          retryable: caught.retryable,
          stage: caught.stage,
          reason: caught.reason,
          refusal: caught.refusal,
          detail: caught.detail,
          requestId: caught.requestId,
          clientTradeId: caught.clientTradeId,
          signedCalls: signed,
        },
        calls,
      )
    }

    // 2c. Immediate rebuild with the SAME `clientTradeId` on an unchanged request.
    {
      const calls: WireCall[] = []
      const client = new CandleClient({
        apiUrl: API,
        apiKey: KEY,
        maxRetries: 0,
        fetch: (async (input: string | URL, init?: RequestInit) => {
          const u = new URL(String(input))
          const body = init?.body ? JSON.parse(String(init.body)) : {}
          calls.push({
            n: calls.length + 1,
            method: init?.method ?? "GET",
            host: u.host,
            path: u.pathname,
            clientTradeId: body.clientTradeId,
            maxSlippageBps: body.maxSlippageBps,
          })
          if (calls.length === 1) {
            return new Response(JSON.stringify(PRESIGN_SLIPPAGE_ENVELOPE), { status: 500, headers: { "content-type": "application/json" } })
          }
          return Response.json(builtOk(body.clientTradeId, body.maxSlippageBps ?? 100))
        }) as unknown as typeof fetch,
      })
      const req = {
        clientTradeId: "stop-sell-same-id",
        mint: MINT,
        side: "sell" as const,
        amountRaw: "91598938670",
        payer: { type: "linked" as const, linkedWalletId: "lw_fixture_1" },
      }
      let firstErr: any
      let rebuilt: any
      try {
        await client.buildTrade(req)
      } catch (e: any) {
        firstErr = e
        if (e instanceof CandleApiError && e.reason === "presign_refused" && e.retryable) {
          rebuilt = await client.buildTrade(req)
        }
      }
      assert.equal(calls.length, 2)
      assert.equal(rebuilt?.status, "built")
      record(
        "sdk-pkg-retry-same-id-fresh-quote",
        "sdk-client",
        "sdk",
        { idStrategy: "same-clientTradeId", maxSlippageBps: "default" },
        {
          firstRefusal: firstErr.refusal,
          firstRetryable: firstErr.retryable,
          secondStatus: rebuilt.status,
          sameClientTradeId: calls[0]?.clientTradeId === calls[1]?.clientTradeId,
          minOutRaw: rebuilt.artifacts.minOutRaw,
        },
        calls,
      )
    }

    // 2d. Immediate rebuild with a NEW `clientTradeId` when widening `maxSlippageBps` on a stop-loss sell.
    {
      const calls: WireCall[] = []
      const client = new CandleClient({
        apiUrl: API,
        apiKey: KEY,
        maxRetries: 0,
        fetch: (async (input: string | URL, init?: RequestInit) => {
          const u = new URL(String(input))
          const body = init?.body ? JSON.parse(String(init.body)) : {}
          calls.push({
            n: calls.length + 1,
            method: init?.method ?? "GET",
            host: u.host,
            path: u.pathname,
            clientTradeId: body.clientTradeId,
            maxSlippageBps: body.maxSlippageBps,
          })
          if (calls.length === 1) {
            return new Response(JSON.stringify(PRESIGN_SLIPPAGE_ENVELOPE), { status: 500, headers: { "content-type": "application/json" } })
          }
          return Response.json(builtOk(body.clientTradeId, body.maxSlippageBps))
        }) as unknown as typeof fetch,
      })
      let firstErr: any
      let rebuilt: any
      try {
        await client.buildTrade({
          clientTradeId: "stop-sell-100bps",
          mint: MINT,
          side: "sell",
          amountRaw: "91598938670",
          maxSlippageBps: 100,
          payer: { type: "linked", linkedWalletId: "lw_fixture_1" },
        })
      } catch (e: any) {
        firstErr = e
        if (e instanceof CandleApiError && e.reason === "presign_refused" && e.retryable && e.detail?.includes("maxSlippageBps")) {
          rebuilt = await client.buildTrade({
            clientTradeId: "stop-sell-500bps",
            mint: MINT,
            side: "sell",
            amountRaw: "91598938670",
            maxSlippageBps: 500,
            payer: { type: "linked", linkedWalletId: "lw_fixture_1" },
          })
        }
      }
      assert.equal(calls.length, 2)
      assert.equal(rebuilt?.status, "built")
      record(
        "sdk-pkg-retry-wider-slippage-new-id",
        "sdk-client",
        "sdk",
        { idStrategy: "new-clientTradeId-on-param-change", fromBps: 100, toBps: 500 },
        {
          firstRefusal: firstErr.refusal,
          secondStatus: rebuilt.status,
          distinctClientTradeId: calls[0]?.clientTradeId !== calls[1]?.clientTradeId,
          minOutRawAt500Bps: rebuilt.artifacts.minOutRaw,
        },
        calls,
      )
    }
  }

  // 3. Shipped `@candledottv/mcp@0.10.45` (`bin.candle-mcp`) relaying `presign_refused` answers.
  {
    let seq = 0
    const baseEnv = (scenario: { status: number; apiBody: Record<string, unknown> }, log: string) => ({
      PATH: process.env.PATH ?? "",
      HOME: join(workDir, "home"),
      TZ: "UTC",
      CANDLE_PLAIN: "1",
      CANDLE_NO_UPDATE_NOTIFIER: "1",
      CANDLE_API_URL: API,
      CANDLE_API_KEY: KEY,
      CANDLE_CONFIG_DIR: configDir,
      CANDLE_KEYRING_PASSPHRASE: KEYRING_PASSPHRASE,
      PRESIGN_REFUSED_SCENARIO: JSON.stringify(scenario),
      PRESIGN_REFUSED_LOG: log,
    })
    const readLog = (log: string): WireCall[] =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : []

    const mcpCases: {
      id: string
      tool: "candle_trade" | "candle_swap"
      args: Record<string, unknown>
      status: number
      apiBody: Record<string, unknown>
    }[] = [
      {
        id: "mcp-pkg-trade-stop-sell-presign-slippage",
        tool: "candle_trade",
        args: { mint: MINT, side: "sell", percent: 100, maxSlippageBps: 100, clientTradeId: "mcp-stop-sell-1" },
        status: 500,
        apiBody: PRESIGN_SLIPPAGE_ENVELOPE,
      },
      {
        id: "mcp-pkg-trade-buy-presign-insufficient-lamports",
        tool: "candle_trade",
        args: { mint: MINT, side: "buy", amount: "0.05", clientTradeId: "mcp-buy-lamports-1" },
        status: 400,
        apiBody: {
          success: false,
          error: {
            code: "INSUFFICIENT_OWNER_BALANCE",
            message: "The paying wallet <payer> does not hold enough SOL for this buy; nothing was signed or sent.",
            retryable: false,
            stage: "not_broadcast",
            reason: "presign_refused",
            refusal: "simulation_failed",
            detail: "Transfer: insufficient lamports 500000, need 52000000",
          },
        },
      },
      {
        id: "mcp-pkg-swap-presign-slippage",
        tool: "candle_swap",
        args: { from: "SOL", to: "USDC", amount: "0.25", maxSlippageBps: 100, clientSwapId: "mcp-swap-1" },
        status: 500,
        apiBody: PRESIGN_SLIPPAGE_ENVELOPE,
      },
    ]

    for (const c of mcpCases) {
      const log = join(workDir, `mcp-${seq++}.log`)
      const client = new Client({ name: "harness-presign-packages", version: "1" })
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--preload", PRELOAD, MCP_ENTRY],
        env: baseEnv({ status: c.status, apiBody: c.apiBody }, log),
        stderr: "ignore",
      })
      await client.connect(transport)
      let reply: any
      try {
        reply = await client.callTool({ name: c.tool, arguments: c.args })
      } finally {
        await client.close()
      }
      const replyText = scrub(String(reply.content?.[0]?.text ?? ""))
      const cleanArgs = JSON.parse(scrub(JSON.stringify(c.args))) as Record<string, unknown>
      record(
        c.id,
        "mcp-package",
        "mcp",
        { tool: c.tool, ...cleanArgs },
        { isError: reply.isError === true, reply: JSON.parse(replyText) },
        readLog(log),
      )
    }

    // 4. Shipped `@candledottv/cli@0.13.47` (`bin.candle`) on `candle swap --yes --json` when build refuses pre-sign.
    {
      const log = join(workDir, `cli-${seq++}.log`)
      const proc = Bun.spawn(
        [
          process.execPath,
          "--preload",
          PRELOAD,
          CLI_ENTRY,
          "swap",
          "SOL",
          MINT,
          "--amount",
          "0.05",
          "--wallet",
          PAYER,
          "--rpc-url",
          "https://rpc.test",
          "--client-trade-id",
          "cli-tee-stop-1",
          "--yes",
          "--json",
        ],
        {
          env: baseEnv({ status: 500, apiBody: PRESIGN_SLIPPAGE_ENVELOPE }, log),
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
        },
      )
      const [stdout, _stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      record(
        "cli-pkg-swap-presign-slippage",
        "cli-package",
        "cli",
        { command: "swap SOL <mint> --amount 0.05 --wallet <payer> --client-trade-id cli-tee-stop-1 --yes --json" },
        { exitCode, json: JSON.parse(scrub(stdout.trim())) },
        readLog(log),
      )
    }
  }

  // 5. Shipped `@candledottv/agent-sdk@0.6.39` `README.md` and `dist/errors.d.ts` declarations.
  {
    const readme = readFileSync(join(pkgDir("@candledottv/agent-sdk"), "README.md"), "utf8")
    const errorsMatch = /(?:^|\n)(## Errors\n[\s\S]*?)(?=\n## |$)/.exec(readme)
    assert.ok(errorsMatch?.[1], "missing ## Errors in @candledottv/agent-sdk README.md")
    const errorsParagraph = errorsMatch[1].trim().split("\n\n")[1]!
    assert.ok(errorsParagraph.includes("presign_refused"), "SDK README names presign_refused")
    assert.ok(errorsParagraph.includes("refusal"), "SDK README names refusal")
    assert.ok(errorsParagraph.includes("detail"), "SDK README names detail")
    record("sdk-pkg-readme-errors", "package-docs", "docs", { file: "@candledottv/agent-sdk/README.md" }, { text: errorsParagraph })

    const errorsDts = readFileSync(join(pkgDir("@candledottv/agent-sdk"), "dist/errors.d.ts"), "utf8")
    const hasPayloadRefusal = /interface CandleErrorPayload[\s\S]*?\brefusal\?:\s*string;/.test(errorsDts)
    const hasPayloadDetail = /interface CandleErrorPayload[\s\S]*?\bdetail\?:\s*string;/.test(errorsDts)
    const hasClassRefusal = /class CandleApiError[\s\S]*?readonly refusal\?:\s*string;/.test(errorsDts)
    const hasClassDetail = /class CandleApiError[\s\S]*?readonly detail\?:\s*string;/.test(errorsDts)
    const hasClassRequestId = /class CandleApiError[\s\S]*?readonly requestId\?:\s*string;/.test(errorsDts)
    assert.ok(hasPayloadRefusal && hasPayloadDetail && hasClassRefusal && hasClassDetail && hasClassRequestId)
    record(
      "sdk-pkg-dts-fields",
      "package-docs",
      "docs",
      { file: "@candledottv/agent-sdk/dist/errors.d.ts" },
      {
        payloadRefusal: hasPayloadRefusal,
        payloadDetail: hasPayloadDetail,
        classRefusal: hasClassRefusal,
        classDetail: hasClassDetail,
        classRequestId: hasClassRequestId,
      },
    )
  }

  const serialized = JSON.stringify(rows)
  for (const forbidden of [KEY, MINT, PAYER, KEYRING_PASSPHRASE, "BEGIN"]) {
    assert.ok(!serialized.includes(forbidden), `package fixture leaked ${forbidden}`)
  }

  const outPath = join(import.meta.dir, "../test/fixtures/candle-presign-refused-packages.json")
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        about:
          "Offline pre-sign build refusal and stop-loss retry contracts (BE-4292, BE-4293, BE-4342, BE-4345) recorded from the published npm packages (@candledottv/agent-sdk 0.6.39, @candledottv/mcp 0.10.45, @candledottv/cli 0.13.47), not a monorepo checkout: CandleApiError carrying refusal and detail (plus requestId and trade()'s clientTradeId), immediate rebuilds on retryable presign_refused builds with the same or a new clientTradeId, the shipped MCP server relaying cause \"slippage_exceeded\", and the shipped CLI exiting 1 before signing. Every fetch is intercepted in memory.",
        packages,
        entryPoints: { sdk: sdkManifest.main, mcp: mcpManifest.bin["candle-mcp"], cli: cliManifest.bin.candle },
        rows,
      },
      null,
      2,
    )}\n`,
  )
  console.log(`Recorded ${rows.length} offline presign-refused package contracts (${Object.entries(pins).map(([k, v]) => `${k}@${v}`).join(", ")}).`)
} finally {
  globalThis.fetch = originalFetch
  rmSync(workDir, { recursive: true, force: true })
}
