// The wire format: these pin the pieces on their own, apart from a server.
import { expect, test } from "bun:test"
import { encodeLine, LineDecoder, MAX_MESSAGE_BYTES, PROTOCOL_VERSION, protocolMajor, refused, RPC_REFUSED } from "./rpc"

test("the protocol is 2.0", () => {
  expect(PROTOCOL_VERSION).toBe("2.0")
  expect(protocolMajor(PROTOCOL_VERSION)).toBe(2)
})

test("protocolMajor reads major.minor and nothing else", () => {
  expect(protocolMajor("1.0")).toBe(1)
  expect(protocolMajor("2.13")).toBe(2)
  for (const bad of ["2", "2.0.1", "v2.0", "", 2, undefined]) expect(protocolMajor(bad)).toBeUndefined()
})

test("lines split across chunks are joined; blank lines are skipped", () => {
  const decoder = new LineDecoder()
  expect(decoder.push(Buffer.from('{"a":1}\n{"b"'))).toEqual({ lines: ['{"a":1}'], oversized: 0 })
  expect(decoder.push(Buffer.from(':2}\n\n  \n'))).toEqual({ lines: ['{"b":2}'], oversized: 0 })
})

test("a multi-byte character split across chunks survives", () => {
  const decoder = new LineDecoder()
  const bytes = Buffer.from('"🚀"\n')
  expect(decoder.push(bytes.subarray(0, 3)).lines).toEqual([])
  expect(decoder.push(bytes.subarray(3)).lines).toEqual(['"🚀"'])
})

test("an oversized line is reported once and skipped, and the stream carries on", () => {
  const decoder = new LineDecoder(16)
  const first = decoder.push(Buffer.from("x".repeat(40)))
  expect(first).toEqual({ lines: [], oversized: 1 })
  expect(decoder.push(Buffer.from("x".repeat(40)))).toEqual({ lines: [], oversized: 0 })
  expect(decoder.push(Buffer.from('xx\n{"ok":1}\n'))).toEqual({ lines: ['{"ok":1}'], oversized: 0 })
  expect(decoder.push(Buffer.from(`${"y".repeat(20)}\n"ok"\n`))).toEqual({ lines: ['"ok"'], oversized: 1 })
})

test("the default limit is 1 MiB", () => {
  expect(MAX_MESSAGE_BYTES).toBe(1024 * 1024)
  expect(() => encodeLine("x".repeat(MAX_MESSAGE_BYTES))).toThrow()
  expect(encodeLine({ a: 1 })).toBe('{"a":1}\n')
})

test("a refusal carries its stable code in data", () => {
  expect(refused("CARD_EXPIRED", "That card expired.", { cardId: "c1" }).body()).toEqual({
    code: RPC_REFUSED,
    message: "That card expired.",
    data: { code: "CARD_EXPIRED", cardId: "c1" },
  })
})
