// A wallet's balance read straight from the chain, over the same RPC the candle CLI uses for TEE trades. Only for
// TEE wallets Candle no longer lists, whose funds no Candle read shows any more.
// - Solana (candle.rpcUrl, else the acting CLI profile's, else Solana's public endpoint): SOL, and how many token
//   accounts still hold something.
// - An EVM chain (candle.evmRpcUrl, else the CLI's built-in RPC for the chain): the native balance only. Nothing
//   lists an EVM wallet's tokens once Candle has dropped it, so they're said as not read, never as none.
import { solanaRpcFault } from "../config"
import { terminalText } from "../shared/terminal-text"

export const PUBLIC_SOLANA_RPC = "https://api.mainnet-beta.solana.com"
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PQnx7a8B8EuZtUwUWo"]
const TIMEOUT_MS = 10_000

/**
 * SOL (or an EVM chain's native asset, in wei, under the same field), and the token accounts that still hold
 * something; `tokens` is null (with why) when the native read
 * answered and the token read didn't, as the public endpoint's rate limit often does. Every error is the
 * RPC's host and a reason made safe for a terminal, never the URL (which may carry a key).
 */
export type ChainBalance = { /** The native balance in its smallest unit: lamports, or wei. */ lamports: bigint; tokens: number | null; tokensError?: string; readAt: number } | { error: string; readAt: number }

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export async function readChainBalance(input: { url: string; address: string; now: number; fetch?: Fetch }): Promise<ChainBalance> {
  const fault = solanaRpcFault(input.url)
  if (fault) return { error: terminalText(`the RPC ${fault}`, { maxLength: 240 }), readAt: input.now }
  const call = async (method: string, params: unknown[]): Promise<unknown> => {
    const res = await (input.fetch ?? (fetch as unknown as Fetch))(input.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { result?: unknown; error?: { message?: unknown } }
    if (body.error) throw new Error(typeof body.error.message === "string" ? body.error.message.slice(0, 200) : "the RPC refused it")
    return body.result
  }
  const why = (error: unknown) => terminalText(`${new URL(input.url).host}: ${error instanceof Error ? (error.name === "TimeoutError" ? "no answer in 10 s" : error.message) : String(error)}`, { maxLength: 240 })
  let lamports: bigint
  try {
    const balance = (await call("getBalance", [input.address])) as { value?: unknown }
    if (typeof balance?.value !== "number" || !Number.isSafeInteger(balance.value) || balance.value < 0) throw new Error("the RPC's answer had no balance")
    lamports = BigInt(balance.value)
  } catch (error) {
    return { error: why(error), readAt: input.now }
  }
  // A good SOL balance is kept when the token read fails: the tokens are unknown, not none.
  try {
    let tokens = 0
    for (const programId of TOKEN_PROGRAMS) {
      const accounts = (await call("getTokenAccountsByOwner", [input.address, { programId }, { encoding: "jsonParsed" }])) as { value?: unknown }
      for (const a of Array.isArray(accounts?.value) ? accounts.value : []) {
        const amount = (a as { account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: unknown } } } } } })?.account?.data?.parsed?.info?.tokenAmount?.amount
        if (typeof amount === "string" && /^\d+$/.test(amount) && BigInt(amount) > 0n) tokens++
      }
    }
    return { lamports, tokens, readAt: input.now }
  } catch (error) {
    return { lamports, tokens: null, tokensError: why(error), readAt: input.now }
  }
}

/** An EVM wallet's native balance (`eth_getBalance`, latest), over the chain's RPC; its tokens are said as not read. */
export async function readEvmBalance(input: { url: string; address: string; now: number; fetch?: Fetch }): Promise<ChainBalance> {
  const fault = solanaRpcFault(input.url)
  if (fault) return { error: terminalText(`the RPC ${fault}`, { maxLength: 240 }), readAt: input.now }
  try {
    const res = await (input.fetch ?? (fetch as unknown as Fetch))(input.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [input.address, "latest"] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { result?: unknown; error?: { message?: unknown } }
    if (body.error) throw new Error(typeof body.error.message === "string" ? body.error.message.slice(0, 200) : "the RPC refused it")
    if (typeof body.result !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(body.result)) throw new Error("the RPC's answer had no balance")
    return { lamports: BigInt(body.result), tokens: null, tokensError: "only the native balance is read on chain", readAt: input.now }
  } catch (error) {
    return { error: terminalText(`${new URL(input.url).host}: ${error instanceof Error ? (error.name === "TimeoutError" ? "no answer in 10 s" : error.message) : String(error)}`, { maxLength: 240 }), readAt: input.now }
  }
}
