import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { canonicalJson, NotCanonical } from "./canonical-json"

test("keys are sorted at every depth, with no whitespace", () => {
  expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}')
})

test("keys sort by UTF-16 code unit, so upper case comes before lower case", () => {
  expect(canonicalJson({ b: 1, B: 2, a: 3, _: 4, "10": 5, "9": 6 })).toBe('{"10":5,"9":6,"B":2,"_":4,"a":3,"b":1}')
})

test("numbers print as JavaScript prints them", () => {
  expect(canonicalJson([0.5, 1e21, 1e-7, -0, 300, 0.1 + 0.2])).toBe("[0.5,1e+21,1e-7,0,300,0.30000000000000004]")
})

test("strings are escaped as JSON.stringify does", () => {
  expect(canonicalJson({ s: 'a"b\\c\n\u0001é🚀' })).toBe('{"s":"a\\"b\\\\c\\n\\u0001é🚀"}')
})

test("an undefined field is left out, as it would be on the wire", () => {
  expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
})

test("a null is kept as null, and differs from a field left out (a profile edit clears a field with one)", () => {
  expect(canonicalJson(null)).toBe("null")
  expect(canonicalJson({ b: { x: null }, a: [1, null] })).toBe('{"a":[1,null],"b":{"x":null}}')
  expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}))
  expect(canonicalJson({ a: null, b: undefined })).toBe('{"a":null}')
})

test("values JSON can't carry exactly are refused", () => {
  for (const bad of [NaN, Infinity, -Infinity, 10n, () => 1, Symbol("s"), new Date(0), new Map(), [undefined]]) {
    expect(() => canonicalJson({ v: bad })).toThrow(NotCanonical)
  }
})

test("booleans and empty containers", () => {
  expect(canonicalJson({ t: true, f: false, o: {}, l: [] })).toBe('{"f":false,"l":[],"o":{},"t":true}')
})

// The card hash: sha256 of canonical JSON {kind, tool, params, opId, environment, profile}.
// The digest was computed outside this code (sha256sum over the literal string), so the vector pins the
// encoding, not just agreement with itself.
test("card-hash vector", () => {
  const opId = "0b5f7c2e-4d1a-4e8b-9f3a-2c6d8e1f4a7b"
  const card = {
    tool: "candle_trade",
    kind: "trade",
    profile: "default",
    environment: "live",
    opId,
    params: {
      side: "buy",
      mint: "MoonFake11111111111111111111111111111111111",
      amount: 0.5,
      quoteAsset: "SOL",
      maxSlippageBps: 300,
      clientTradeId: opId,
    },
  }
  const text = canonicalJson(card)
  expect(text).toBe(
    '{"environment":"live","kind":"trade","opId":"0b5f7c2e-4d1a-4e8b-9f3a-2c6d8e1f4a7b","params":{"amount":0.5,' +
      '"clientTradeId":"0b5f7c2e-4d1a-4e8b-9f3a-2c6d8e1f4a7b","maxSlippageBps":300,' +
      '"mint":"MoonFake11111111111111111111111111111111111","quoteAsset":"SOL","side":"buy"},' +
      '"profile":"default","tool":"candle_trade"}',
  )
  expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe(
    "be3a871044375fd27d800052ba2ab88214e77afcb3b3bb868e4a741e4c3ef3e5",
  )
})

test("the same card with its keys in another order hashes the same", () => {
  const a = canonicalJson({ kind: "swap", params: { from: "SOL", to: "USDC", amount: 1 } })
  const b = canonicalJson({ params: { amount: 1, to: "USDC", from: "SOL" }, kind: "swap" })
  expect(a).toBe(b)
})
