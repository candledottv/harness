// Preloaded into the shipped `@candledottv/mcp` and `@candledottv/cli` processes by
// `scripts/run-hood-gen2-packages.ts` (BE-4351): answers every fetch offline and appends each call, with its
// parsed body, to `HOOD_GEN2_LOG`. Only the dry-run launch endpoint is answered with a made-up preview; anything
// else is logged and answered 404. Nothing reaches a network and nothing is signed.
import { appendFileSync } from "node:fs"

const logPath = process.env.HOOD_GEN2_LOG
let seq = 0
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const u = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url)
  const method = init?.method ?? (input instanceof Request ? input.method : "GET")
  let body: unknown = null
  if (typeof init?.body === "string") {
    try {
      body = JSON.parse(init.body)
    } catch {
      body = init.body
    }
  }
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ n: ++seq, method, host: u.host, path: u.pathname, body })}\n`)
  if (u.pathname === "/api/v1/agent/wallets/embedded") {
    return Response.json({ embeddedWalletPermission: "allowed", wallets: { solana: { address: "7ZL9FvkpCMgdvzfoMSYZSuCXLCYN25dfgtDXej1BBJaB" }, evm: { address: "0x4444444444444444444444444444444444444444" } } })
  }
  if (method === "POST" && u.pathname === "/api/v1/launch/headless/dry-run") {
    return Response.json({ success: true, dryRun: true, wouldLaunch: true })
  }
  return Response.json({ success: false, error: { code: "NOT_FOUND", message: "fixture 404", retryable: false } }, { status: 404 })
}) as unknown as typeof fetch
