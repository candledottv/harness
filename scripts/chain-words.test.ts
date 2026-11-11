// The chain is read in one place. Outside src/shared/chains.ts, no code writes out the chains as a union, matches a
// Solana or EVM address with a pattern of its own, or takes an address starting `0x` for Hood: each goes through
// chains.ts, so a second EVM chain needs no change elsewhere. Tests may write addresses and chains as they like.
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { repoFiles } from "./repo-files"

const ROOT = join(import.meta.dir, "..")
const CHAINS = "src/shared/chains.ts"

/** What only chains.ts may say, each with why. */
export const CHAIN_WORDS: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /"solana"\s*\|\s*"hood"|"hood"\s*\|\s*"solana"/, why: "a written-out chain union: use ChainSlug" },
  { pattern: /\{32,44\}/, why: "a Solana address pattern: use familyOfAddress, isSolanaAddress or SOLANA_ADDRESS_SOURCE" },
  { pattern: /0x\[0-9a-fA-F\]\{40\}/, why: "an EVM address pattern: use isEvmAddress or EVM_ADDRESS_SOURCE" },
  { pattern: /startsWith\(\s*["'`]0[xX]["'`]\s*\)/, why: "a chain guessed from 0x: read the stored chain, or requestChain at a request's edge" },
]

/** The app's own code, tests left out. */
const appCode = () => repoFiles().filter((f) => /^src\/.*\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && f !== CHAINS)

export function chainWordHits(files: readonly string[], read = (f: string) => readFileSync(join(ROOT, f), "utf8")): string[] {
  const out: string[] = []
  for (const file of files)
    read(file)
      .split("\n")
      .forEach((line, i) => {
        for (const w of CHAIN_WORDS) if (w.pattern.test(line)) out.push(`${file}:${i + 1}: ${w.why}`)
      })
  return out
}

test("the chain is read only through chains.ts", () => {
  expect(chainWordHits(appCode())).toEqual([])
})

test("the check sees each kind it refuses, and passes chains.ts's own words", () => {
  const lines: Record<string, string> = {
    "a.ts": 'type C = "solana" | "hood"',
    "b.ts": "const M = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/",
    "c.ts": "const E = /^0x[0-9a-fA-F]{40}$/",
    "d.ts": 'const hood = mint.startsWith("0x")',
    "e.ts": "const fine = requestChain(mint)",
  }
  expect(chainWordHits(Object.keys(lines), (f) => lines[f]!).map((h) => h.split(":")[0])).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"])
  expect(appCode()).not.toContain(CHAINS)
})
