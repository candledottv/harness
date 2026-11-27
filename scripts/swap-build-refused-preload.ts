// Preloaded into the shipped `@candledottv/cli` process by `scripts/run-swap-build-refused-packages.ts` (BE-4462):
// answers every fetch offline, appends each call to `SWAP_BUILD_REFUSED_LOG`, and answers `POST /agent/swap/build`
// with the scenario's recorder stand-in (a mapped API envelope). Any path outside the build flow (a submit, an
// execute, an RPC send) is logged and then throws, so a signed or broadcast transaction fails the run.
import { appendFileSync } from "node:fs"

const scenario = JSON.parse(process.env.SWAP_BUILD_REFUSED_SCENARIO ?? "{}") as { status?: number; apiBody?: Record<string, unknown> }
const logPath = process.env.SWAP_BUILD_REFUSED_LOG
const PAYER = "7ZL9FvkpCMgdvzfoMSYZSuCXLCYN25dfgtDXej1BBJaB"

let seq = 0
const log = (entry: Record<string, unknown>) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ n: ++seq, ...entry })}\n`)
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const u = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url)
  const method = init?.method ?? (input instanceof Request ? input.method : "GET")
  const rawBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined

  if (u.pathname.endsWith("/keys/self/public-profile")) {
    log({ method, host: u.host, path: u.pathname })
    return Response.json({ published: false, profile: null })
  }
  if (u.pathname.includes("/jobs/")) {
    log({ method, host: u.host, path: u.pathname.replace(/\/jobs\/[^/]+$/, "/jobs/<id>") })
    return Response.json({ success: false, error: { code: "JOB_NOT_FOUND", message: "Not found", retryable: false } }, { status: 404 })
  }
  if (u.pathname === "/api/v1/agent/wallets/embedded") {
    log({ method, host: u.host, path: u.pathname })
    return Response.json({ embeddedWalletPermission: "allowed", wallets: { solana: { address: PAYER }, evm: null } })
  }
  if (u.pathname === "/api/v1/agent/wallets/trading") {
    log({ method, host: u.host, path: u.pathname })
    return Response.json({
      scopes: ["swap:write"],
      privyAppId: "app_fixture",
      embeddedWalletPermission: "allowed",
      embeddedWallets: { solana: { address: PAYER }, evm: null },
      page: [{ id: "lw_1", address: PAYER, label: "tee", chain: "solana", active: true, allowLaunch: true, privyWalletId: "pw_1" }],
      isDone: true,
    })
  }
  if (u.host === "rpc.test") {
    log({ method, host: u.host, path: "<rpc>", rpc: rawBody?.method })
    const mintData = Buffer.alloc(82)
    mintData[44] = 6
    mintData[45] = 1
    return Response.json({ jsonrpc: "2.0", id: rawBody?.id ?? 1, result: { value: { data: [mintData.toString("base64"), "base64"], decimals: 6 } } })
  }
  if (method === "POST" && u.pathname === "/api/v1/agent/swap/build") {
    log({ method, host: u.host, path: u.pathname, ...(rawBody?.clientTradeId ? { clientTradeId: rawBody.clientTradeId } : {}) })
    return new Response(JSON.stringify(scenario.apiBody ?? {}), {
      status: scenario.status ?? 500,
      headers: { "content-type": "application/json", "x-candle-request-id": "req_fixture_swapbuild" },
    })
  }
  log({ method, host: u.host, path: u.pathname, unexpected: true })
  throw new Error(`unexpected fetch in swap-build-refused preload: ${method} ${u.origin}${u.pathname}`)
}) as unknown as typeof fetch
