import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseWalletsFile, serializeWalletsFile, WALLETS_HEADER, WalletsFileStore } from "./wallets-file"

const A = "Embd3333333333333333333333333333333333333333"
const B = "Dest6666666666666666666666666666666666666666"

describe("reading wallets.toml", () => {
  test("names by address", () => {
    expect(parseWalletsFile(`[names]\n"${A}" = "main"\n"${B}" = "my exchange"\n`)).toEqual({ names: { [A]: "main", [B]: "my exchange" }, groups: {}, problems: [] })
  })

  test("each problem named by its line, and only what's wrong left out", () => {
    const file = parseWalletsFile(`[names]\n"${A}" = "main"\n"not-an-address" = "x"\n"${B}" = " spaced"\n\n[colours]\nx = 1\n`)
    expect(file.names).toEqual({ [A]: "main" })
    expect(file.problems).toEqual([
      'wallets.toml line 6: "colours" isn\'t something this file holds (names, groups)',
      'wallets.toml line 3: "not-an-address" isn\'t an address: each name is "<address>" = "<name>"',
      'wallets.toml line 4: " spaced" can\'t name a wallet: a wallet\'s name can\'t begin or end with a space',
    ])
  })

  test("a name that isn't text, and a file that isn't TOML", () => {
    expect(parseWalletsFile(`[names]\n"${A}" = 3\n`).problems[0]).toContain("must be text")
    const bad = parseWalletsFile(`[names\n`)
    expect(bad.names).toEqual({})
    expect(bad.problems[0]).toContain("isn't valid TOML")
  })

  test("written and read back the same, quotes and emoji included", () => {
    const names = { [B]: 'the "big" one 🔥', [A]: "main" }
    const text = serializeWalletsFile(names)
    expect(text.startsWith(WALLETS_HEADER)).toBe(true)
    expect(parseWalletsFile(text)).toEqual({ names, groups: {}, problems: [] })
  })
})

describe("groups in wallets.toml", () => {
  test("a group by prefix, by list, or both; a trailing * is Candle's way of writing a prefix", () => {
    const file = parseWalletsFile(`[names]\n"${A}" = "main"\n\n[groups.bots]\nprefix = "bot-*"\n\n[groups.swing]\nwallets = ["${B}", "swing-b"]\n\n[groups.copy]\nprefix = "copy-"\nwallets = ["beta"]\n`)
    expect(file.problems).toEqual([])
    expect(file.groups).toEqual({ bots: { prefix: "bot-" }, swing: { wallets: [B, "swing-b"] }, copy: { prefix: "copy-", wallets: ["beta"] } })
  })

  test("each problem in a group named by its line, and only what's wrong left out", () => {
    const file = parseWalletsFile(`[groups.bots]\nprefix = " bot"\n\n[groups."my bots"]\nprefix = "x"\n\n[groups.swing]\nwallets = "swing-a"\ncolour = "red"\n\n[groups.empty]\n\n[groups.ok]\nwallets = ["a", 3, ""]\n`)
    expect(file.groups).toEqual({ ok: { wallets: ["a"] } })
    expect(file.problems).toEqual([
      'wallets.toml line 2: bots\'s prefix " bot" can\'t be used: a prefix can\'t begin or end with a space',
      'wallets.toml line 4: "my bots" can\'t name a group: a group\'s name is one word of letters, digits, \'.\', \'_\' and \'-\'',
      "wallets.toml line 8: swing's wallets must be a list in brackets: wallets = [\"<name or address>\", …]",
      'wallets.toml line 9: "colour" isn\'t something a group holds (prefix, wallets)',
      "wallets.toml line 11: empty has no prefix and no wallets, so it holds nothing",
      "wallets.toml line 14: ok's wallets: each is a wallet's name or address in quotes (3 and \"\" are left out)",
    ])
  })

  test("groups are written after the names, in name order, and read back the same", () => {
    const groups = { swing: { wallets: [B, "swing b"] }, bots: { prefix: "bot-" } }
    const text = serializeWalletsFile({ [A]: "main" }, groups)
    expect(text).toContain(`[names]\n"${A}" = "main"\n\n[groups.bots]\nprefix = "bot-"\n\n[groups.swing]\nwallets = ["${B}", "swing b"]\n`)
    expect(parseWalletsFile(text)).toEqual({ names: { [A]: "main" }, groups: { bots: { prefix: "bot-" }, swing: { wallets: [B, "swing b"] } }, problems: [] })
  })
})

describe("the file on disk", () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })
  const store = () => {
    dir = mkdtempSync(join(tmpdir(), "wallets-file-"))
    const path = join(dir, "wallets.toml")
    return { path, s: new WalletsFileStore(path) }
  }

  test("no file is no names, and naming one writes it, 0600", () => {
    const { path, s } = store()
    expect(s.read()).toEqual({ names: {}, groups: {}, problems: [] })
    expect(s.write({ [A]: "main" })).toEqual({ ok: true })
    expect(s.read().names).toEqual({ [A]: "main" })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(s.write({ [A]: undefined })).toEqual({ ok: true })
    expect(s.read().names).toEqual({})
  })

  test("a hand edit is read when the file changes", () => {
    const { path, s } = store()
    s.write({ [A]: "main" })
    writeFileSync(path, `[names]\n"${A}" = "renamed by hand"\n"${B}" = "exchange"\n`)
    expect(s.read().names).toEqual({ [A]: "renamed by hand", [B]: "exchange" })
  })

  test("naming a wallet keeps the groups, and changing a group keeps the names", () => {
    const { s } = store()
    s.write({ [A]: "main" })
    expect(s.writeGroups({ bots: { prefix: "bot-" } })).toEqual({ ok: true })
    s.write({ [B]: "exchange" })
    expect(s.read()).toEqual({ names: { [A]: "main", [B]: "exchange" }, groups: { bots: { prefix: "bot-" } }, problems: [] })
    s.writeGroups({ bots: undefined, swing: { wallets: [B] } })
    expect(s.read().groups).toEqual({ swing: { wallets: [B] } })
  })

  test("a change that wouldn't read back is refused, and the names and the undo still work", () => {
    const { path, s } = store()
    s.write({ [A]: "main" })
    const before = readFileSync(path, "utf8")
    const r = s.writeGroups({ bots: { prefix: JSON.parse('"bot\\ud800"') } })
    expect(r.ok).toBe(false)
    expect(readFileSync(path, "utf8")).toBe(before)
    expect(s.read()).toEqual({ names: { [A]: "main" }, groups: {}, problems: [] })
    expect(s.writeGroups({ bots: { prefix: "bot-" } })).toEqual({ ok: true })
  })

  test("a file with a problem is never written over", () => {
    const { path, s } = store()
    const hand = `[names]\n"${A}" = "main"\n"oops" = "x"\n`
    writeFileSync(path, hand)
    const r = s.write({ [B]: "exchange" })
    expect(r.ok).toBe(false)
    expect((r as { message: string }).message).toContain("line 3")
    expect(readFileSync(path, "utf8")).toBe(hand)
  })
})
