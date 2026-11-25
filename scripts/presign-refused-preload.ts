// Preloaded into the shipped `@candledottv/mcp` and `@candledottv/cli` processes by
// `scripts/run-presign-refused-packages.ts`: intercepts every fetch offline and appends each call to
// `PRESIGN_REFUSED_LOG`. Nothing reaches a network, nothing is signed with a real key, and every address is made up.
import { appendFileSync } from "node:fs"

const scenario = JSON.parse(process.env.PRESIGN_REFUSED_SCENARIO ?? "{}") as {
  status?: number
  apiBody?: Record<string, unknown>
}
const logPath = process.env.PRESIGN_REFUSED_LOG
const PAYER = "7ZL9FvkpCMgdvzfoMSYZSuCXLCYN25dfgtDXej1BBJaB"
const MINT = "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL"

let seq = 0
const log = (entry: Record<string, unknown>) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ n: ++seq, ...entry })}\n`)
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const u = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url)
  const rawBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined

  if (u.host === "rpc.test") {
    log({ method: "POST", host: u.host, path: "<rpc>", rpc: rawBody?.method })
    const mintData = Buffer.alloc(82)
    mintData[44] = 6
    mintData[45] = 1
    return Response.json({
      jsonrpc: "2.0",
      id: rawBody?.id ?? 1,
      result: { value: { data: [mintData.toString("base64"), "base64"], decimals: 6 } },
    })
  }

  if (u.pathname.endsWith("/keys/self/public-profile")) {
    log({ method: init?.method ?? "GET", host: u.host, path: u.pathname })
    return Response.json({ published: false, profile: null })
  }
  if (u.pathname.includes("/jobs/")) {
    const cleanPath = u.pathname.replace(/\/jobs\/[^/]+$/, "/jobs/<id>")
    log({ method: init?.method ?? "GET", host: u.host, path: cleanPath })
    return Response.json({ success: false, error: { code: "JOB_NOT_FOUND", message: "Not found", retryable: false } }, { status: 404 })
  }
  if (u.pathname === "/api/v1/agent/wallets/embedded") {
    log({ method: init?.method ?? "GET", host: u.host, path: u.pathname })
    return Response.json({ embeddedWalletPermission: "allowed", wallets: { solana: { address: PAYER }, evm: null } })
  }
  if (u.pathname === "/api/v1/agent/wallets/trading") {
    log({ method: init?.method ?? "GET", host: u.host, path: u.pathname })
    return Response.json({
      scopes: ["swap:write"],
      privyAppId: "app_fixture",
      embeddedWalletPermission: "allowed",
      embeddedWallets: { solana: { address: PAYER }, evm: null },
      page: [{ id: "lw_1", address: PAYER, label: "tee", chain: "solana", active: true, allowLaunch: true, privyWalletId: "pw_1" }],
      isDone: true,
    })
  }
  if (u.pathname.startsWith("/api/v1/tokens/") && u.pathname.includes("/balance/")) {
    log({ method: init?.method ?? "GET", host: u.host, path: "/api/v1/tokens/<mint>/balance/<payer>" })
    return Response.json({ payload: { balance: "91598938670" } })
  }
  if (
    u.pathname === "/api/v1/trade/agent/build" ||
    u.pathname === "/api/v1/agent/swap" ||
    u.pathname === "/api/v1/agent/swap/build" ||
    u.pathname === "/api/v1/agent/swap/execute"
  ) {
    log({
      method: init?.method ?? "POST",
      host: u.host,
      path: u.pathname,
      ...(rawBody?.clientTradeId || rawBody?.clientSwapId ? { clientTradeId: rawBody.clientTradeId ?? rawBody.clientSwapId } : {}),
      ...(rawBody?.maxSlippageBps !== undefined ? { maxSlippageBps: rawBody.maxSlippageBps } : {}),
    })
    return new Response(JSON.stringify(scenario.apiBody ?? {}), {
      status: scenario.status ?? 500,
      headers: { "content-type": "application/json", "x-candle-request-id": "req_fixture_064152" },
    })
  }

  throw new Error(`unexpected fetch in presign-refused preload: ${u.origin}${u.pathname} (mint=${MINT})`)
}) as unknown as typeof fetch
