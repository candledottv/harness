// A stopped TEE wallet's balance, read on chain: SOL, and how many token accounts still hold something.
import { expect, test } from "bun:test"
import { readChainBalance, readEvmBalance } from "./chain-balance"

const ADDRESS = "StopA111111111111111111111111111111111111111"
const tokenAccount = (amount: string) => ({ account: { data: { parsed: { info: { tokenAmount: { amount } } } } } })

function rpc(answers: Record<string, unknown>, calls: { url: string; method: string; params: unknown[] }[] = []) {
  return async (url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body) as { method: string; params: unknown[] }
    calls.push({ url, method, params })
    const answer = answers[method === "getTokenAccountsByOwner" ? `${method}:${(params[1] as { programId: string }).programId.slice(0, 6)}` : method]
    return { ok: true, status: 200, json: async () => answer }
  }
}

test("SOL and the token accounts that still hold something, over the RPC it's given", async () => {
  const calls: { url: string; method: string; params: unknown[] }[] = []
  const read = await readChainBalance({
    url: "https://rpc.example",
    address: ADDRESS,
    now: 7,
    fetch: rpc(
      {
        getBalance: { result: { value: 41_200_000 } },
        "getTokenAccountsByOwner:Tokenk": { result: { value: [tokenAccount("5"), tokenAccount("0")] } },
        "getTokenAccountsByOwner:Tokenz": { result: { value: [tokenAccount("1")] } },
      },
      calls,
    ),
  })
  expect(read).toEqual({ lamports: 41_200_000n, tokens: 2, readAt: 7 })
  expect(calls.map((c) => c.method)).toEqual(["getBalance", "getTokenAccountsByOwner", "getTokenAccountsByOwner"])
  expect(calls.every((c) => c.url === "https://rpc.example" && c.params[0] === ADDRESS)).toBe(true)
})

test("an RPC that refuses, answers nothing useful, or isn't https says why, with nothing made up", async () => {
  expect(await readChainBalance({ url: "https://rpc.example", address: ADDRESS, now: 1, fetch: rpc({ getBalance: { error: { message: "rate limited" } } }) })).toEqual({ error: "rpc.example: rate limited", readAt: 1 })
  expect(await readChainBalance({ url: "https://rpc.example", address: ADDRESS, now: 1, fetch: rpc({ getBalance: { result: {} } }) })).toEqual({ error: "rpc.example: the RPC's answer had no balance", readAt: 1 })
  const plain = await readChainBalance({ url: "http://rpc.example", address: ADDRESS, now: 1, fetch: rpc({}) })
  expect("error" in plain && plain.error).toContain("isn't https")
})

test("a token read the RPC refuses (the public endpoint's rate limit) keeps the good SOL balance, tokens unknown", async () => {
  const limited = async (url: string, init: { body: string }) => {
    const { method } = JSON.parse(init.body) as { method: string }
    return method === "getBalance" ? { ok: true, status: 200, json: async () => ({ result: { value: 5_000_000 } }) } : { ok: false, status: 429, json: async () => ({}) }
  }
  expect(await readChainBalance({ url: "https://api.mainnet-beta.solana.com", address: ADDRESS, now: 3, fetch: limited })).toEqual({ lamports: 5_000_000n, tokens: null, tokensError: "api.mainnet-beta.solana.com: HTTP 429", readAt: 3 })
})

test("an RPC's own error text reaches no terminal with its escape sequences", async () => {
  const hostile = "\u001b]0;owned\u0007\u001b[2J\u001b[31mrate limited"
  const read = await readChainBalance({ url: "https://rpc.example", address: ADDRESS, now: 1, fetch: rpc({ getBalance: { error: { message: hostile } } }) })
  expect("error" in read && read.error).toContain("rate limited")
  expect(JSON.stringify(read)).not.toContain("\\u001b")
  expect(JSON.stringify(read)).not.toContain("\\u0007")
  const tokens = await readChainBalance({ url: "https://rpc.example", address: ADDRESS, now: 1, fetch: rpc({ getBalance: { result: { value: 1 } }, "getTokenAccountsByOwner:Tokenk": { error: { message: hostile } } }) })
  expect("tokensError" in tokens && tokens.tokensError).toContain("rate limited")
  expect("tokensError" in tokens && tokens.tokensError).not.toContain("\u001b")
})

test("a stopped EVM wallet's native balance, in wei, over the chain's RPC; its tokens said as not read, never none", async () => {
  const HOOD = "0xAbCdEf0123456789aBcDeF0123456789abCDef01"
  const calls: { url: string; method: string; params: unknown[] }[] = []
  const read = await readEvmBalance({ url: "https://hood-rpc.example", address: HOOD, now: 7, fetch: rpc({ eth_getBalance: { result: "0xe35fa931a000" } }, calls) })
  expect(read).toEqual({ lamports: 250_000_000_000_000n, tokens: null, tokensError: "only the native balance is read on chain", readAt: 7 })
  expect(calls).toEqual([{ url: "https://hood-rpc.example", method: "eth_getBalance", params: [HOOD, "latest"] }])
  // Refused, malformed, or not https: why, and nothing made up.
  expect(await readEvmBalance({ url: "https://hood-rpc.example", address: HOOD, now: 1, fetch: rpc({ eth_getBalance: { error: { message: "rate limited" } } }) })).toEqual({ error: "hood-rpc.example: rate limited", readAt: 1 })
  expect(await readEvmBalance({ url: "https://hood-rpc.example", address: HOOD, now: 1, fetch: rpc({ eth_getBalance: { result: "12" } }) })).toEqual({ error: "hood-rpc.example: the RPC's answer had no balance", readAt: 1 })
  const plain = await readEvmBalance({ url: "http://hood-rpc.example", address: HOOD, now: 1, fetch: rpc({}) })
  expect("error" in plain && plain.error).toContain("isn't https")
})
