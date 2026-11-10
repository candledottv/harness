// What ships with the repo reads on its own. Nothing in it, code comments and test names included, carries words
// from how the Candle Harness was built (its stages, plans, tasks, decisions, requests to Candle, a person) or points to a
// workfile outside the repo, since a reader gets the repo and the docs and nothing else. The docs site's pages are
// held to the same words by its own test, and the feature map by scripts/docs-map.test.ts.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { BUILD_WORDS } from "./docs-map"
import { repoFiles } from "./repo-files"

const ROOT = join(import.meta.dir, "..")

/**
 * Every file in the repo (scripts/repo-files.ts), less Candle's skills in skills/ and build-skills/ (copied unchanged, with a changed copy for the skills check's own
 * test), the lockfile, which is npm's words, and BIP-39's word list, which is BIP-39's (checked unchanged by its
 * hash in shared/wallet-secret.test.ts).
 */
export function shippedFiles(): string[] {
  return repoFiles().filter((f) => !f.startsWith("skills/") && !f.startsWith("build-skills/") && !f.startsWith("test/fixtures/skills-changed/") && f !== "bun.lock" && f !== "src/shared/bip39-english.txt")
}

function hits(files: readonly string[], read = (f: string) => readFileSync(join(ROOT, f), "utf8")): string[] {
  const out: string[] = []
  for (const file of files) {
    const text = read(file)
    if (text.includes("\0")) continue
    text.split("\n").forEach((line, i) => {
      const hit = BUILD_WORDS.exec(line)
      if (hit) out.push(`${file}:${i + 1}: "${hit[0]}"`)
    })
  }
  return out
}

describe("what ships", () => {
  test("nothing in the repo says how the Candle Harness was built", () => {
    expect(hits(shippedFiles())).toEqual([])
  })

  test("the docs folder is gone: the guide lives on docs.candle.tv", () => {
    expect(existsSync(join(ROOT, "docs"))).toBe(false)
  })

  test("each kind of build word is caught, and the agent's own notes aren't", () => {
    // Each is written with a · inside its build word, taken out here, so this file carries none of them.
    const planted = [
      "Arrives in mile·stone 8.",
      "Per pl·an 7.",
      "Per Ta·sk F1.",
      "Deci·sion 37 holds it.",
      "A build·er's call.",
      "Closing them is switch·ed on once Candle checks it.",
      "Ma·tt asked for it.",
      "Since sess·ion 64.",
      "Candle request R·45.",
      "Shipped in M·1b.",
      "As Q·1's shapes showed.",
      "Promoted from spi·ke 4.",
      "Per des·ign §· 5.6.",
      "See no·tes/2026-10-29-handoff.md.",
      "From pl·ans/2026-10-29-plan-7.md.",
      "Run bu·ild-env/attach.sh.",
      "Drawn in design/mo·ckups/cockpit-v1.html.",
      "Seen in the sec·ond pass.",
      "Rev·iew focus 9.",
      "Carried over as T·-6.",
      "A test·er's run found it.",
      "Since the v0.2.6 r·un.",
      "As the mock·up sets it.",
      "Correction to the par·ity map.",
      "Tell the help·er Claude.",
      "Ported from Candle's fir·st TUI.",
      "Candle request R·3.",
      "From ~/.config/candle-tui-d·ata/key.",
      "Pays from tui-t·ee.",
      "Sent to tui-c·old.",
    ].map((line) => line.replaceAll("·", ""))
    const got = hits(["planted"], () => planted.join("\n"))
    expect(got.length).toBe(planted.length)
    const clean = "Pick a plan, approve a card in 2m, read notes/moon.md and memory/notes/a.md. Free, Pro or Max. T0 + 5 * MIN, F12."
    expect(hits(["clean"], () => clean)).toEqual([])
  })
})
