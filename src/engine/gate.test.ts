import { expect, test } from "bun:test"
import { checkAddresses, checkFigures, extractAddresses, extractFigures, numbersIn, seenFrom } from "./gate"

const MOON = "MoonFake11111111111111111111111111111111111"
const PEPE = "PepeFake11111111111111111111111111111111111"
const EVM = "0x52908400098527886E0F7030069857D2E4169EE7"

test("an address seen in a Candle tool result is labelled candle", () => {
  expect(checkAddresses(`Buy ${MOON}`, seenFrom(`{"mint":"${MOON}"}`, "candle")))
    .toEqual({ ok: true, labelled: [{ address: MOON, source: "candle" }], unknown: [] })
})
test("candle wins over web when both saw it", () => {
  const seen = [...seenFrom(MOON, "web"), ...seenFrom(MOON, "candle")]
  expect(checkAddresses(MOON, seen).labelled[0]!.source).toBe("candle")
})
test("a web-only address passes, labelled web", () => {
  expect(checkAddresses(MOON, seenFrom(MOON, "web")).labelled).toEqual([{ address: MOON, source: "web" }])
})
test("an address in no tool result is unknown", () => {
  const r = checkAddresses(`try ${PEPE}`, seenFrom(MOON, "candle"))
  expect(r).toEqual({ ok: false, labelled: [], unknown: [PEPE] })
})
test("look-alikes and case changes don't pass for Solana", () => {
  const lookAlike = "MoonFake11111111111111111111111111111111112"
  expect(checkAddresses(lookAlike, seenFrom(MOON, "candle")).unknown).toEqual([lookAlike])
  expect(checkAddresses(MOON.toLowerCase(), seenFrom(MOON, "candle")).ok).toBe(false)
})
test("EVM addresses match case-insensitively", () => {
  expect(checkAddresses(EVM.toLowerCase(), seenFrom(EVM, "candle")).ok).toBe(true)
})
test("an unknown EVM address written in two cases is unknown in both, so each is masked; a known one is labelled once", () => {
  const twice = `Send to ${EVM}, again: ${EVM.toLowerCase()}`
  expect(checkAddresses(twice, [])).toEqual({ ok: false, labelled: [], unknown: [EVM, EVM.toLowerCase()] })
  expect(checkAddresses(twice, seenFrom(EVM, "web"))).toEqual({ ok: true, labelled: [{ address: EVM, source: "web" }], unknown: [] })
})
test("addresses inside URLs and code fences are still checked", () => {
  const r = checkAddresses("```\nhttps://x.example/t/" + PEPE + "\n```", [])
  expect(r.unknown).toEqual([PEPE])
})
test("a short substring of a seen address is not an address", () => {
  expect(extractAddresses(MOON.slice(0, 20))).toEqual([])
})
test("base58 that doesn't decode to 32 bytes is not an address", () => {
  expect(extractAddresses("commit c1dfd96eea8cc2b62785275bca38ac261256e278")).toEqual([]) // a git hash with no 0: 30 bytes
  expect(extractAddresses(MOON.slice(0, 40))).toEqual([]) // a 40-character cut of MOON: 30 bytes
  expect(extractAddresses("z".repeat(44))).toEqual([]) // 33 bytes
})
test("a longer base58 run is not split into an address", () => {
  expect(extractAddresses(MOON + "abc" + MOON)).toEqual([])
})
test("source precedence: candle, web, shell, file", () => {
  const seen = [...seenFrom(MOON, "file"), ...seenFrom(MOON, "shell"), ...seenFrom(MOON, "web")]
  expect(checkAddresses(MOON, seen).labelled[0]!.source).toBe("web")
  expect(checkAddresses(MOON, seenFrom(MOON, "file")).labelled[0]!.source).toBe("file")
})

// Beyond the plan's list.

/** Plain base58 encoding, for building test keys. */
function base58(bytes: Uint8Array): string {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let out = ""
  while (n > 0n) {
    out = A[Number(n % 58n)] + out
    n /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    out = `1${out}`
  }
  return out
}

test("a key whose first byte is zero (a leading 1) is an address", () => {
  const key = new Uint8Array(32).map((_, i) => (i === 0 ? 0 : (i * 37) % 256))
  const addr = base58(key)
  expect(addr.startsWith("1")).toBe(true)
  expect(extractAddresses(`mint ${addr}.`)).toEqual([addr])
})
test("a 32-byte key encodes to an address, and 31 or 33 bytes don't", () => {
  const key = (n: number) => base58(new Uint8Array(n).map((_, i) => 200 - i))
  expect(extractAddresses(key(32))).toEqual([key(32)])
  expect(extractAddresses(key(31))).toEqual([])
  expect(extractAddresses(key(33))).toEqual([])
})
test("a transaction hash isn't cut down to an EVM address", () => {
  expect(extractAddresses(`tx 0x${"ab12".repeat(16)}`)).toEqual([])
  expect(extractAddresses(`x${EVM}`)).toEqual([]) // glued to a longer word
})
test("addresses come out deduplicated, in order, EVM by case-insensitive match", () => {
  expect(extractAddresses(`${PEPE} ${EVM} ${MOON} ${PEPE} ${EVM.toLowerCase()}`)).toEqual([PEPE, EVM, MOON])
})
test("a reply with no addresses passes", () => {
  expect(checkAddresses("the market is quiet", [])).toEqual({ ok: true, labelled: [], unknown: [] })
})

// The figure gate: only figures stated as read data are checked, so the `?` stays worth reading.

const marked = (reply: string, ...outputs: string[]) => checkFigures(reply, outputs.flatMap(numbersIn)).marked.map((f) => f.text)
const figures = (reply: string) => extractFigures(reply).map((f) => f.text)

test("figures match after normalising: K, M and B either way, commas, JSON's exponents", () => {
  expect(marked("Market cap $812K, volume 1.2M, liquidity: 45,000", '{"marketCapUsd":812345.2,"volume24h":1204331,"liquidityUsd":45012.7}')).toEqual([])
  expect(marked("FDV is $3.4b", '{"fdv":3.41e9}')).toEqual([])
  expect(marked("price 0.000042", '{"priceUsd":4.21e-5}')).toEqual([])
  expect(marked("mcap $812K and 1.2M volume", "mcap 812K · vol 1.2M")).toEqual([]) // Hacc's own short forms
  expect(marked("you hold about 1.2 million MOON", '{"amount":1200400}')).toEqual([])
})
test("a figure rounded at its own last digit is read, beyond 0.5%; one off by that digit isn't", () => {
  expect(marked("MOON's price is $0.42", '{"priceUsd":0.4249}')).toEqual([])
  expect(marked("MOON's price is $0.43", '{"priceUsd":0.4249}')).toEqual(["$0.43"])
  // One significant digit rounds too far to count: $1M isn't read from 1.45M.
  expect(marked("market cap $1M", '{"mc":1450000}')).toEqual(["$1M"])
})
test("a round figure's trailing zeros are rounding, at two significant digits at the coarsest", () => {
  // Claude Code on Hacc's volume_24h_usd 3031.06: "about $3,000 of volume" was marked.
  expect(marked("about $3,000 of volume in 24 hours", '{"volume_24h_usd":3031.0553406267854}')).toEqual([])
  expect(marked("$3K volume", '{"volume_24h_usd":3031.06}')).toEqual([])
  expect(marked("$3,000 volume", '{"volume_24h_usd":3100}')).toEqual(["$3,000"])
  expect(marked("market cap $1M", '{"mc":1040000}')).toEqual([])
  expect(marked("market cap $1M", '{"mc":1200000}')).toEqual(["$1M"])
  expect(marked("liquidity 45,000", '{"liquidityUsd":45400}')).toEqual([])
  expect(marked("liquidity 45,000", '{"liquidityUsd":45600}')).toEqual(["45,000"])
})
test("a raw amount is read at its decimals: a held amount, SOL in lamports, ETH in wei", () => {
  const portfolio = '{"embedded":[{"chain":"solana","lamports":"2000000000","tokens":[{"mint":"x","amountRaw":"12345678901","decimals":6},{"mint":"y","amountRaw":"5000000000","decimals":6}]}],"hood":{"embedded":[{"wei":"1500000000000000000","tokens":[]}]}}'
  expect(marked("You hold 12,345.678901 MOON, or 12,345.68; balance is 2 SOL", portfolio)).toEqual([])
  expect(marked("you hold 5,000 of the other", portfolio)).toEqual([])
  expect(marked("Hood balance: 1.5 ETH", portfolio)).toEqual([])
  // A raw amount with no decimals beside it is only its own number.
  expect(marked("you hold 12,345.68", '{"amountRaw":"12345678901"}')).toEqual(["12,345.68"])
  expect(marked("you hold 6,000", portfolio)).toEqual(["6,000"])
  // Through Grok's use_tool, the same JSON inside a string.
  expect(marked("| Holding |\n|---|\n| 12,345.678901 tokens |", JSON.stringify({ content: [{ type: "text", text: portfolio }] }))).toEqual([])
})
test("a dollar figure on a balance or holding is the agent's own sum, not read data", () => {
  // Pi on Claude Haiku 5.5: 12,345.678901 MOON at $0.63.
  expect(figures("you hold 12,345.678901, so the holding is about $7,778 and half is about $3,889")).toEqual(["12,345.678901"])
  expect(figures("| balance | holding |\n|---|---|\n| $50 | $7,778 |")).toEqual([])
  expect(figures("price is $0.63, liquidity $100K")).toEqual(["$0.63", "$100K"])
})
test("a planted wrong price is marked, and so is a wrong balance or holding", () => {
  const output = '{"symbol":"MOON","priceUsd":0.0042,"marketCapUsd":4200000,"balance":3.4}'
  expect(marked("MOON trades at $0.0042 with a market cap of $4.2M", output)).toEqual([])
  expect(marked("MOON trades at $0.0047 with a market cap of $4.2M", output)).toEqual(["$0.0047"])
  expect(marked("**Price:** $0.0051 · **Market cap:** $4.2M", output)).toEqual(["$0.0051"])
  expect(marked("Your balance is 3.4 SOL and you hold 1,200 MOON", output)).toEqual(["1,200"])
})
test("a worked-out conversion, sum, size or estimate isn't marked: it isn't stated as read data", () => {
  // The tool showed 0.1 SOL and SOL at $150.2; "$15" is the agent's own sum, and says so.
  expect(figures("0.1 SOL is about $15. 0.37 × $150 = $55.50. That's ≈1,200 MOON before fees.")).toEqual([])
  expect(figures("You're up $12.30 on it, and the position is worth $120. Size it at $10.")).toEqual([])
  expect(figures("It was $0.0051 an hour ago")).toEqual([]) // no data word: not checked
})
test("a figure in a table is checked by its column's header", () => {
  const table = "| token | price | holders | value |\n|---|---|---|---|\n| MOON | $0.0051 | 1,200 | $55 |"
  expect(figures(table)).toEqual(["$0.0051"])
  expect(marked(table, '{"priceUsd":0.0042}')).toEqual(["$0.0051"])
  expect(figures("| price | x |\n|---|---|")).toEqual([]) // a header row isn't data
})
test("percents, counts, dates and times aren't figures, beside a data word or not", () => {
  expect(figures("price up 12.4% today, volume +3 %, 50 percent of 12 holders")).toEqual([])
  expect(figures("price on 2026-10-29 at 18:41 UTC, 10/29, 24h volume, 5m candles, Q3, v2, 3x")).toEqual([])
  expect(figures("3 wallets, 12 trades, 2 TEE wallets, 30 steps, 7 tools")).toEqual([])
  expect(figures("price fell 12%")).toEqual([])
})
test("what is read data: a data word before the figure, or just after it", () => {
  expect(figures("price 0.0042; market cap of 812K; liquidity: 45,000; balance is 3.4; holds 12.5; trades at $0.42")).toEqual(["0.0042", "812K", "45,000", "3.4", "12.5", "$0.42"])
  expect(figures("$4.2M market cap, $100K liquidity, $1.2M in 24h volume, 812K MC")).toEqual(["$4.2M", "$100K", "$1.2M", "812K"])
  expect(figures("**Price:** `$0.42`, price is still $0.43")).toEqual(["$0.42", "$0.43"])
})
test("an address's digits are never a figure", () => {
  expect(figures(`price of ${MOON} at 0x52908400098527886E0F7030069857D2E4169EE7`)).toEqual([])
})
test("each figure says where it starts, for the pane's mark", () => {
  const reply = "MOON's price is $0.47, mcap $4.2M"
  expect(extractFigures(reply)).toHaveLength(2)
  for (const f of extractFigures(reply)) expect(reply.slice(f.at, f.at + f.text.length)).toBe(f.text)
})
test("a figure the reply itself says is from memory isn't marked; one passed off as read still is", () => {
  // A real reply: the table's own header said "(from memory)", and 10 of 11 figures got a `?`.
  const step5 =
    "Here are rough figures from my training data. I called no tools, so none of these are live reads.\n\n| Token | Rough price (from memory) | Rough market cap (from memory) |\n|---|---|---|\n| SOL | ~$150–200 | ~$80–100B |\n| BONK | ~$0.00002 | ~$1.5–2B |\n\nIf you want current numbers, I can pull them."
  expect(figures(step5).length).toBeGreaterThan(4)
  expect(marked(step5)).toEqual([])
  // Said in the figure's own paragraph, or in the line that introduces its table.
  expect(marked("From memory, BONK's price was about $0.00002.")).toEqual([])
  expect(marked("These are unverified:\n\n| token | price |\n|---|---|\n| BONK | $0.00002 |")).toEqual([])
  // Stated as read with no such words: marked, even when another paragraph is from memory.
  expect(marked("BONK is trading at $0.00002.")).toEqual(["$0.00002"])
  expect(marked("SOL was about $150 from memory.\n\nBONK is trading at $0.00002 right now.")).toEqual(["$0.00002"])
})
