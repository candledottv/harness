import { expect, test } from "bun:test"
import { answerText, copyableAnswer } from "./app"

test("a typed read's answer is drawn with its indent kept, and copied back as the JSON the CLI gave", () => {
  const answer = { ok: true, wallets: [{ label: "bot-1", chain: "solana", note: "two words" }], count: 1 }
  const shown = answerText(JSON.stringify(answer))
  // Drawn: every indented line starts with no-break spaces, so wrapping can't eat the indent.
  expect(shown.split("\n").filter((l) => l.startsWith(" ")).length).toBeGreaterThan(3)
  const copied = copyableAnswer(shown)
  expect(copied.split("\n").some((l) => l.startsWith(" "))).toBe(false)
  expect(JSON.parse(copied)).toEqual(answer)
})
