import { expect, test } from "bun:test"
import { addressKey, sameAddress } from "./address-key"

test("an EVM address matches in any case; a Solana address only as written", () => {
  const checksummed = "0xAbCdEf0123456789aBcDeF0123456789abCDef01"
  expect(sameAddress(checksummed, checksummed.toLowerCase())).toBe(true)
  expect(addressKey(checksummed)).toBe(checksummed.toLowerCase())
  expect(sameAddress("MoonFake11111111111111111111111111111111111", "moonfake11111111111111111111111111111111111")).toBe(false)
  expect(sameAddress("MoonFake11111111111111111111111111111111111", "MoonFake11111111111111111111111111111111111")).toBe(true)
  expect(sameAddress(undefined, undefined)).toBe(false)
})
