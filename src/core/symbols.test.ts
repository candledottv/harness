import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { MAX_SYMBOLS, SymbolBook } from "./symbols"

const dir = mkdtempSync("/tmp/chrn-sym-")
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const MOON = "MoonFake11111111111111111111111111111111111"

test("a name Candle gave is kept across a restart, private, and nothing but a mint and its symbol", () => {
  const file = join(dir, "symbols.json")
  const book = new SymbolBook(file)
  expect(book.get(MOON)).toBeUndefined()
  book.learn(MOON, "MOON")
  book.learn("not a mint", "X")
  book.learn(MOON, "  ")
  book.flush()
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ symbols: { [MOON]: "MOON" } })
  expect(new SymbolBook(file).get(MOON)).toBe("MOON")
})

test("a file that can't be read starts empty; a planted control character is cleaned; the oldest goes past the cap", () => {
  const file = join(dir, "bad.json")
  writeFileSync(file, "{nope")
  expect(new SymbolBook(file).get(MOON)).toBeUndefined()
  writeFileSync(file, JSON.stringify({ symbols: { [MOON]: "MO\u001b[31mON" } }))
  expect(new SymbolBook(file).get(MOON)).not.toContain("\u001b")
  const many = new SymbolBook(join(dir, "many.json"))
  const mint = (n: number) => `Mint${String(n).padStart(6, "0").replace(/0/g, "z")}`.padEnd(44, "1")
  for (let n = 0; n <= MAX_SYMBOLS; n++) many.learn(mint(n), `T${n}`)
  expect(many.get(mint(0))).toBeUndefined()
  expect(many.get(mint(MAX_SYMBOLS))).toBe(`T${MAX_SYMBOLS}`)
  many.flush()
})
