import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TokenBook } from "./tokens"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function openBook() {
  const dir = mkdtempSync(join(tmpdir(), "tokens-"))
  dirs.push(dir)
  const paths = { tokens: join(dir, "tokens.json"), viewToken: join(dir, "view.token") }
  return { book: await TokenBook.open(paths, () => 1_000_000), paths }
}

const onFile = (path: string) => (JSON.parse(readFileSync(path, "utf8")) as { harness: { tokenId: string }[] }).harness.map((r) => r.tokenId).sort()

test("two turns' tokens revoked at the same moment are both refused, and the file holds neither", async () => {
  const { book, paths } = await openBook()
  const a = await book.mintHarness("claude", "agent-a")
  const b = await book.mintHarness("claude", "agent-b")
  expect(await Promise.all([book.revoke(a.tokenId), book.revoke(b.tokenId)])).toEqual([true, true])
  expect(book.authenticate(a.token)).toBeUndefined()
  expect(book.authenticate(b.token)).toBeUndefined()
  expect(book.harnessCount()).toBe(0)
  expect(onFile(paths.tokens)).toEqual([])
})

test("a turn's token revoked while another agent's turn mints one stays refused, and the new one works", async () => {
  const { book, paths } = await openBook()
  const c = await book.mintHarness("claude", "agent-c")
  const [revoked, e] = await Promise.all([book.revoke(c.tokenId), book.mintHarness("pi", "agent-e")])
  expect(revoked).toBe(true)
  expect(book.authenticate(c.token)).toBeUndefined()
  expect(book.authenticate(e.token)).toMatchObject({ role: "harness", agent: "agent-e" })
  expect(onFile(paths.tokens)).toEqual([e.tokenId])
})

test("a token minted while another is revoked is kept, whichever order they start in", async () => {
  const { book } = await openBook()
  const c = await book.mintHarness("claude", "agent-c")
  const [e] = await Promise.all([book.mintHarness("pi", "agent-e"), book.revoke(c.tokenId)])
  expect(book.authenticate(e.token)).toMatchObject({ role: "harness", agent: "agent-e" })
  expect(book.authenticate(c.token)).toBeUndefined()
  expect(book.harnessCount()).toBe(1)
})

test("each rotation tells its listeners the new view token and the one it replaced", async () => {
  const { book } = await openBook()
  const told: [string, string | undefined][] = []
  book.onRotate((token, previous) => told.push([token, previous]))
  await book.rotateViewToken()
  await book.rotateViewToken()
  expect(told).toHaveLength(3)
  expect(told[0]![1]).toBeUndefined()
  expect(told[1]![1]).toBe(told[0]![0])
  expect(told[2]![1]).toBe(told[1]![0])
  expect(book.authenticate(told[1]![0])).toBeUndefined()
  expect(book.authenticate(told[2]![0])).toEqual({ role: "view" })
})
