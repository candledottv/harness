// Every word the first-run script waits for is one the code draws.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { PATH_LINE, shortAccount, signedInAs } from "./first-run"
import { PICKS, SCREENS } from "./screens"

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

const src = sources(join(import.meta.dir, "../../src"))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n")

describe("the first run's screens", () => {
  for (const [screen, words] of Object.entries(SCREENS)) {
    test(screen, () => {
      for (const w of words) expect(src.includes(w), `"${w}" isn't drawn anywhere in src/`).toBe(true)
    })
  }
  test("the PATH line is found in each shell's form, as install.sh prints it", () => {
    const printed = readFileSync(join(import.meta.dir, "../../install.sh"), "utf8")
      .split("\n")
      .filter((l) => />> ~\/\.(zshrc|bashrc) && source/.test(l))
      .map((l) => /echo "\s*(echo .*)"/.exec(l)![1]!.replaceAll("\\$", "$").replaceAll("${shown_dir}", "~/.local/bin"))
    expect(printed.some((l) => l.includes(".zshrc"))).toBe(true)
    expect(printed.some((l) => l.includes(".bashrc"))).toBe(true)
    for (const l of printed) expect(PATH_LINE.test(l), l).toBe(true)
  })
  test("each pick is a row the code draws", () => {
    for (const w of Object.values(PICKS)) expect(src.includes(w), `"${w}" isn't drawn anywhere in src/`).toBe(true)
  })
  // A run can sign in to the wrong account, so the signed-in step checks the rail against --account.
  test("the account the rail names, and --account in any of its forms", () => {
    expect(signedInAs(" │ ✓ Sign in to Candle      │ │\n │   Made…Wxyz · candle-harness │ │  Connect your agent")).toBe("Made…Wxyz")
    expect(signedInAs(" │ ▸ Sign in to Candle      │")).toBeUndefined()
    expect(src.includes("shortAddress(view.facts.signIn.account)} · ")).toBe(true)
    expect(shortAccount("Made…Two2")).toBe("Made…Two2")
    expect(shortAccount("Made...Two2")).toBe("Made…Two2")
    expect(shortAccount("MadeUpAcct111111111111111111111111111111Wxyz")).toBe("Made…Wxyz")
  })
})
