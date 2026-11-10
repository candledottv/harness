// A name that could pass for another token's carries its short address; plain names don't.
import { expect, test } from "bun:test"
import { looksLikeAnother, tokenLabel } from "./token-label"

const MINT = "Cfq1AbCdEfGhJkLmNpQrStUvWxYz123456784pmp"

test("Latin look-alikes among Latin letters, or a name made only of them, carry the short address", () => {
  // A Cyrillic ѕ, С and Е; and Cyrillic Е, Greek Τ, Cyrillic Н making "ETH".
  for (const name of ["ѕame", "Сoin", "Еlon", "ЕΤН", "СОІN"]) expect(tokenLabel(name, MINT)).toBe(`${name} (Cfq1…4pmp)`)
})

test("a plain Latin name, or one wholly in another script, shows as it is", () => {
  for (const name of ["COIN", "same", "José", "Привет", "柴犬", "Pepe币", "dog™", "$WIF"]) expect([name, looksLikeAnother(name)]).toEqual([name, false])
  expect(tokenLabel("COIN", MINT)).toBe("COIN")
  expect(tokenLabel(undefined, MINT)).toBeUndefined()
})
