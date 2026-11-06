import { expect, test } from "bun:test"
import { fakeAddress, HaccScrubber, leftovers, scrubRecording } from "./scrub-hacc"

const real = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
const evm = "0x4ac4a33101abb2aa21167de2b881429b915818a3"

test("addresses become the same fake wherever they appear, keys and routes included", () => {
  const s = new HaccScrubber()
  const out = scrubRecording(s, {
    route: `/v1/market/wallet/${real}/stats`,
    query: { q: "SOMETICKER", limit: "20", group_by: "token" },
    answer: { wallet_address: real, mint_counts: { [real]: 3 }, deployer: evm, payload: { tx_hash: `0x${"ab".repeat(32)}` } },
  }) as { route: string; query: Record<string, string>; answer: Record<string, unknown> }
  const fake = (out.answer as { wallet_address: string }).wallet_address
  expect(fake).not.toBe(real)
  expect(out.route).toBe(`/v1/market/wallet/${fake}/stats`)
  expect(Object.keys(out.answer.mint_counts as object)).toEqual([fake])
  expect(out.query).toEqual({ q: "fake-symbol-1", limit: "20", group_by: "token" })
  expect(leftovers(out)).toEqual([])
})

test("third-party text is replaced; Hacc's own enums, words, numbers and times are kept", () => {
  const s = new HaccScrubber()
  const v = s.value({
    summary: `bought for the first time by ${real}`,
    wallet_label: "someone's wallet",
    wallet_twitter: "somehandle",
    tweet_url: "https://x.com/somehandle/status/1",
    pattern: "confluence",
    error: `wallet ${real} not in book`,
    usd_value: "157.07",
    created_at: "2026-10-29T02:49:32.244Z",
  }) as Record<string, string>
  expect(v.summary).toBe("fake-summary-1")
  expect(v.wallet_label).toBe("fake-wallet_label-1")
  expect(v.wallet_twitter).toBe("fake-wallet_twitter-1")
  expect(v.tweet_url).toBe("https://hacc.example/tweet_url-1")
  expect(v.pattern).toBe("confluence")
  expect(v.error).toBe(`wallet ${s.string("address", real)} not in book`)
  expect(v.usd_value).toBe("157.07")
  expect(v.created_at).toBe("2026-10-29T02:49:32.244Z")
  expect(leftovers(v)).toEqual([])
})

test("long arrays keep five rows and say how many there were", () => {
  const out = scrubRecording(new HaccScrubber(), { answer: { signals: Array.from({ length: 20 }, (_, i) => ({ id: i })) } }) as { answer: { signals: unknown[] }; truncated: Record<string, number> }
  expect(out.answer.signals).toHaveLength(5)
  expect(out.truncated).toEqual({ "$.signals": 20 })
})

test("fake addresses are distinct for every number (1 is base58's zero)", () => {
  expect(new Set(Array.from({ length: 3000 }, (_, i) => fakeAddress(i + 1))).size).toBe(3000)
})

test("anything the scrub didn't make is found", () => {
  expect(leftovers({ a: `see ${real}` })).toHaveLength(1)
  expect(leftovers({ a: "https://x.com/someone" })).toHaveLength(1)
})
