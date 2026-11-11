// Hacc's EVM safety check in words: null is unsaid, never clean; amber only where a field warrants a look.
import { expect, test } from "bun:test"
import { haccCheckWords, haccSafety } from "./hacc-safety"

const FIELDS = [
  "creator_address",
  "creator_pct",
  "owner_pct",
  "honeypot",
  "cannot_buy",
  "cannot_sell_all",
  "buy_tax_pct",
  "sell_tax_pct",
  "transfer_tax_pct",
  "mintable",
  "transfer_pausable",
  "hidden_owner",
  "can_take_back_ownership",
  "blacklisted",
  "is_proxy",
  "open_source",
  "holder_count",
  "total_supply",
  "lp_locked_pct",
  "lp_holder_count",
  "honeypot_with_same_creator",
]
/** Hacc's answer with every field null but those given, as a fresh Hood token's was (all 21 keys always present). */
const answer = (set: Record<string, unknown> = {}) => ({ chain: "hood", market: {}, safety: { ...Object.fromEntries(FIELDS.map((f) => [f, null])), ...set } })

test("a fresh token's all-null answer is no check yet, never clean", () => {
  const check = haccSafety(answer(), 1)!
  expect(check).toMatchObject({ said: [], amber: [], none: true })
  expect(haccCheckWords(check)).toBe("Hacc has no check for this token yet: not checked, not clean")
})

test("one field said and the rest unsaid: the word, and how many Hacc didn't say", () => {
  const check = haccSafety(answer({ cannot_buy: false }), 1)!
  expect(check.none).toBe(false)
  expect(check.said).toEqual([])
  expect(haccCheckWords(check)).toBe("Hacc: nothing flagged in the 1 it checked (16 more not said by Hacc)")
})

test("a checked token in words, as Hacc's, with no amber when nothing warrants it", () => {
  const check = haccSafety(answer({ honeypot: false, cannot_sell_all: false, cannot_buy: false, buy_tax_pct: 0, sell_tax_pct: 0, transfer_tax_pct: 0, mintable: false, transfer_pausable: false, hidden_owner: false, can_take_back_ownership: false, blacklisted: false, is_proxy: false, open_source: true, owner_pct: 0, creator_pct: 0, lp_locked_pct: 92, honeypot_with_same_creator: false }), 1)!
  expect(check.amber).toEqual([])
  expect(haccCheckWords(check)).toBe("Hacc: no honeypot, 0% buy and sell tax, LP locked 92%, owner holds none")
})

test("amber only for a honeypot, a token that can't all be sold, a sell tax over 10%, and trading its owner can pause", () => {
  expect(haccSafety(answer({ honeypot: true }), 1)!.amber).toEqual(["a honeypot: it can be bought and not sold"])
  expect(haccSafety(answer({ cannot_sell_all: true }), 1)!.amber).toEqual(["it can't all be sold"])
  expect(haccSafety(answer({ buy_tax_pct: 2, sell_tax_pct: 12 }), 1)!).toMatchObject({ amber: ["a 12% sell tax"], said: ["2% buy tax"] })
  expect(haccSafety(answer({ sell_tax_pct: 10 }), 1)!).toMatchObject({ amber: [], said: ["10% sell tax"] })
  expect(haccSafety(answer({ transfer_pausable: true }), 1)!.amber).toEqual(["its owner can pause trading"])
  // Said, not amber: worth reading, not a mark on every second token.
  const plain = haccSafety(answer({ mintable: true, hidden_owner: true, is_proxy: true, open_source: false, honeypot_with_same_creator: true }), 1)!
  expect(plain.amber).toEqual([])
  expect(plain.said).toEqual(["mintable", "a hidden owner", "upgradeable (a proxy)", "source not verified", "its creator made a honeypot before"])
  expect(haccCheckWords(haccSafety(answer({ honeypot: true, lp_locked_pct: 50 }), 1)!)).toBe("Hacc: a honeypot: it can be bought and not sold, LP locked 50% (15 more not said by Hacc)")
})

test("an answer with no safety block is no check", () => {
  expect(haccSafety({ chain: "hood", market: {} }, 1)).toBeUndefined()
  expect(haccSafety(null, 1)).toBeUndefined()
})
