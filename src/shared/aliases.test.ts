// config.toml's [aliases]: what's used, and what's left out with its line.
import { expect, test } from "bun:test"
import { BUILT_INS, expandPart, MAX_PARTS, parseAliases } from "./aliases"

const read = (body: string) => parseAliases(`activeAgent = "a"\n\n[aliases]\n${body}\n`)

test("an alias replaces the first word and keeps the rest; names ignore case", () => {
  const { map, problems } = read(`b5 = "buy $5 of"\nS50 = "sell 50% of"`)
  expect(problems).toEqual([])
  expect(expandPart("b5 JUP", map)).toEqual(["buy $5 of JUP"])
  expect(expandPart("B5 JUP as swing", map)).toEqual(["buy $5 of JUP as swing"])
  expect(expandPart("s50 BONK", map)).toEqual(["sell 50% of BONK"])
  // Not the first word: left as typed.
  expect(expandPart("buy b5", map)).toEqual(["buy b5"])
})

test("an alias can hold a chain, and an alias can lead to another", () => {
  const { map, problems } = read(`flip = "b1 JUP; sell 100% of JUP"\nb1 = "buy $1 of"`)
  expect(problems).toEqual([])
  expect(expandPart("flip", map)).toEqual(["buy $1 of JUP", "sell 100% of JUP"])
})

test("a built-in command's name can't be an alias, so buy always means buy", () => {
  const { map, problems } = read(`buy = "sell 100% of"\nKILL = "resume"\nok = "buy $1 of"`)
  expect(map.has("buy")).toBe(false)
  expect(map.has("kill")).toBe(false)
  expect(map.get("ok")).toBe("buy $1 of")
  expect(problems).toEqual([
    "config.toml line 4: alias \"buy\" is left out: buy is a command already, and an alias can't change what it does",
    "config.toml line 5: alias \"KILL\" is left out: kill is a command already, and an alias can't change what it does",
  ])
  for (const word of ["buy", "sell", "swap", "kill", "paper", "live", "resume", "candle"]) expect(BUILT_INS).toContain(word)
})

test("an alias that calls itself, or loops through another, is left out with each it loops through", () => {
  const { map, problems } = read(`me = "me again"\na = "b; buy $1 of JUP"\nb = "a"\nfine = "sell 50% of"`)
  expect([...map.keys()]).toEqual(["fine"])
  expect(problems).toHaveLength(3)
  expect(problems[0]).toMatch(/^config\.toml line 4: alias "me" is left out: it calls itself/)
  expect(problems.some((p) => p.startsWith('config.toml line 5: alias "a" is left out: it calls itself'))).toBe(true)
  expect(problems.some((p) => p.startsWith('config.toml line 6: alias "b" is left out'))).toBe(true)
})

test("bad names and values are named with their lines; the rest are used", () => {
  const { map, problems } = read(`"two words" = "buy $1 of"\nempty = ""\nnum = 5\nctl = "buy\\u0007 $1 of"\nlong = "${"x".repeat(301)}"\nok = "buy $1 of"`)
  expect([...map.keys()]).toEqual(["ok"])
  expect(problems.map((p) => p.split(":")[0])).toEqual(["config.toml line 4", "config.toml line 5", "config.toml line 6", "config.toml line 7", "config.toml line 8"])
  expect(problems[0]).toContain("one word")
  expect(problems[3]).toContain("control character")
})

test(`an alias that runs more than ${MAX_PARTS} parts is left out`, () => {
  const { map, problems } = read(`six = "buy $1 of A; buy $1 of B; buy $1 of C; buy $1 of D; buy $1 of E; buy $1 of F"`)
  expect(map.size).toBe(0)
  expect(problems[0]).toContain(`runs 6 parts, and a chain runs at most ${MAX_PARTS}`)
})

test("no [aliases], no file or a broken file: none, and a broken one says so", () => {
  expect(parseAliases(undefined)).toEqual({ map: new Map(), problems: [] })
  expect(parseAliases(`activeAgent = "a"`).map.size).toBe(0)
  expect(parseAliases(`aliases = "b5"`).problems[0]).toContain("aliases must be a table")
  expect(parseAliases(`[aliases\nb5 = 1`).problems[0]).toContain("isn't valid TOML")
})
