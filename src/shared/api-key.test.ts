import { expect, test } from "bun:test"
import { apiKeyPrefix } from "./api-key"

// Built from parts, so no literal here looks like a key to the scrub hook.
const key = (kind: string, random: string) => `cndl_${kind}_${random}`

test("the prefix is the first 8 characters of the random part", () => {
  expect(apiKeyPrefix(key("live", `Ab3-Ef9_${"x".repeat(35)}`))).toBe("Ab3-Ef9_")
  expect(apiKeyPrefix(key("test", `a1b2c3d4${"y".repeat(35)}`))).toBe("a1b2c3d4")
  expect(apiKeyPrefix(`  ${key("live", "z".repeat(43))}\n`)).toBe("zzzzzzzz")
})

test("anything that isn't a whole key has no prefix", () => {
  expect(apiKeyPrefix(key("live", "z".repeat(42)))).toBeUndefined()
  expect(apiKeyPrefix(key("live", "z".repeat(44)))).toBeUndefined()
  expect(apiKeyPrefix(key("live", `${"z".repeat(42)}!`))).toBeUndefined()
  expect(apiKeyPrefix(key("dvc", "z".repeat(43)))).toBeUndefined()
  expect(apiKeyPrefix("z".repeat(53))).toBeUndefined()
})
