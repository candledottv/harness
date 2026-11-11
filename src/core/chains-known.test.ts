import { expect, test } from "bun:test"
import { mkdtempSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readChainsKnown, saveChainsKnown } from "./chains-known"

test("the chains last in use come back for the next core: Solana always, unknown names dropped, nothing kept means Solana alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chrn-chains-"))
  const path = join(dir, "chains-used.json")
  expect(readChainsKnown(path)).toEqual(["solana"])
  await saveChainsKnown(path, ["solana", "hood"], Date.UTC(2026, 10, 11))
  expect(readChainsKnown(path)).toEqual(["solana", "hood"])
  expect(statSync(path).mode & 0o777).toBe(0o600)
  writeFileSync(path, JSON.stringify({ chains: ["hood", "nonsense", 7] }))
  expect(readChainsKnown(path)).toEqual(["solana", "hood"])
  writeFileSync(path, "not json")
  expect(readChainsKnown(path)).toEqual(["solana"])
})
