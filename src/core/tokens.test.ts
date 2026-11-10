import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

test("a paper test's token works from memory and is never in the file; one a past core wrote is dropped at open", async () => {
  const { book, paths } = await openBook()
  const test = await book.mintBot("test:grid", "momentum")
  const saved = await book.mintBot("grid", "momentum")
  expect(book.authenticate(test.token)).toMatchObject({ role: "bot", bot: "test:grid" })
  const bots = () => (JSON.parse(readFileSync(paths.tokens, "utf8")) as { bot: { bot: string }[] }).bot.map((r) => r.bot)
  expect(bots()).toEqual(["grid"])
  expect(await book.revokeBot("test:grid")).toBe(test.tokenId)
  expect(book.authenticate(test.token)).toBeUndefined()
  // A file from before, holding a test's record: the next core drops it, and keeps the saved bot's.
  const file = JSON.parse(readFileSync(paths.tokens, "utf8")) as { bot: Record<string, unknown>[] }
  file.bot.push({ ...file.bot[0]!, tokenId: "abcdefABCDEF", bot: "test:old" })
  writeFileSync(paths.tokens, JSON.stringify(file))
  const next = await TokenBook.open(paths, () => 2_000_000)
  expect(bots()).toEqual(["grid"])
  expect(next.botToken("test:old")).toBeUndefined()
  expect(next.authenticate(saved.token)).toMatchObject({ role: "bot", bot: "grid" })
})

test("a token whose bot is no longer saved is dropped; a saved bot's, and a running test's, stay", async () => {
  const { book, paths } = await openBook()
  const kept = await book.mintBot("grid", "momentum")
  const gone = await book.mintBot("removed-by-hand", "momentum")
  const test = await book.mintBot("test:grid", "momentum")
  expect(await book.pruneBots(new Set(["grid"]))).toEqual(["removed-by-hand"])
  expect(book.authenticate(gone.token)).toBeUndefined()
  expect(book.authenticate(kept.token)).toMatchObject({ bot: "grid" })
  expect(book.authenticate(test.token)).toMatchObject({ bot: "test:grid" })
  expect((JSON.parse(readFileSync(paths.tokens, "utf8")) as { bot: { bot: string }[] }).bot.map((r) => r.bot)).toEqual(["grid"])
})

test("a view token that can't be written isn't switched to: the old one still attaches, and the file still holds it", async () => {
  const { book, paths } = await openBook()
  await book.publishViewToken()
  const before = readFileSync(paths.viewToken, "utf8").trim()
  const dir = join(paths.viewToken, "..")
  chmodSync(dir, 0o500)
  try {
    // Root writes anywhere: the check means something only where the folder really refuses.
    if (process.getuid?.() !== 0) {
      await expect(book.rotateViewToken()).rejects.toThrow()
      expect(readFileSync(paths.viewToken, "utf8").trim()).toBe(before)
      expect(book.authenticate(before)).toEqual({ role: "view" })
    }
  } finally {
    chmodSync(dir, 0o700)
  }
  // Writable again, the next rotation takes, and the file and the core agree.
  await book.rotateViewToken()
  const after = readFileSync(paths.viewToken, "utf8").trim()
  expect(after).not.toBe(before)
  expect(book.authenticate(before)).toBeUndefined()
  expect(book.authenticate(after)).toEqual({ role: "view" })
})

test("a view token is single-use across hellos that arrive together: while its replacement is written, it's refused", async () => {
  const { book, paths } = await openBook()
  await book.publishViewToken()
  const token = readFileSync(paths.viewToken, "utf8").trim()
  expect(book.authenticate(token)).toEqual({ role: "view" })
  const first = book.rotateViewToken()
  // The second hello's check, before the first's new token has reached the file.
  expect(book.authenticate(token)).toBeUndefined()
  await first
  expect(book.authenticate(token)).toBeUndefined()
  expect(book.authenticate(readFileSync(paths.viewToken, "utf8").trim())).toEqual({ role: "view" })
})

test("rotations asked for together run one after another, and the file ends on the token the core holds", async () => {
  const { book, paths } = await openBook()
  const told: string[] = []
  book.onRotate((token) => told.push(token))
  await Promise.all([book.rotateViewToken(), book.rotateViewToken(), book.rotateViewToken()])
  expect(told).toHaveLength(4)
  expect(readFileSync(paths.viewToken, "utf8").trim()).toBe(told.at(-1)!)
  expect(book.authenticate(told.at(-1)!)).toEqual({ role: "view" })
})
