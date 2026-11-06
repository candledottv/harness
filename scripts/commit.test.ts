import { afterEach, expect, test } from "bun:test"
import { $ } from "bun"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildCommit, commitDefine, PRODUCTION_DEFINE, SHIPPED_DEFINE } from "./commit"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function repo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "chrn-commit-"))
  dirs.push(dir)
  await $`git init -q && git -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty -m one`.cwd(dir).quiet()
  return dir
}

test("a clean tree gives the short commit", async () => {
  const dir = await repo()
  const short = (await $`git rev-parse --short HEAD`.cwd(dir).text()).trim()
  expect(buildCommit(dir)).toBe(short)
})

test("a changed or new file marks it +dirty", async () => {
  const dir = await repo()
  writeFileSync(join(dir, "new.ts"), "")
  expect(buildCommit(dir)).toMatch(/^[0-9a-f]{7,}\+dirty$/)
})

test("outside a git repo it's unknown", () => {
  const dir = mkdtempSync(join(tmpdir(), "chrn-commit-"))
  dirs.push(dir)
  expect(buildCommit(dir)).toBe("unknown")
})

test("the define is one flag whose value is a JS string literal", () => {
  expect(commitDefine("abc1234")).toEqual(["--define", `CANDLE_HARNESS_BUILD_COMMIT=${JSON.stringify("abc1234")}`])
})

test("a compiled build is marked shipped, so harness.register is refused there; source runs aren't", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chrn-shipped-"))
  dirs.push(dir)
  const entry = join(dir, "entry.ts")
  writeFileSync(entry, `import { SHIPPED } from ${JSON.stringify(join(process.cwd(), "src", "version.ts"))}\nconsole.log(SHIPPED)\n`)
  expect((await $`bun ${entry}`.text()).trim()).toBe("false")
  await $`bun build --target=bun ${SHIPPED_DEFINE} ${entry} --outfile ${join(dir, "shipped.js")}`.quiet()
  expect((await $`bun ${join(dir, "shipped.js")}`.text()).trim()).toBe("true")
  // Every compiled build passes it: the binaries and mac-checks.
  for (const file of ["scripts/build.ts", "scripts/mac-checks/build.ts"]) expect(await Bun.file(file).text()).toContain("${SHIPPED_DEFINE}")
})

test("the production define leaves React's development build out of a bundle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chrn-react-"))
  dirs.push(dir)
  const entry = "node_modules/react-reconciler/index.js"
  // "Cascading Update" is a User Timing label only the development build records.
  await $`bun build --target=bun ${entry} --outfile ${join(dir, "dev.js")}`.quiet()
  expect(await Bun.file(join(dir, "dev.js")).text()).toContain("Cascading Update")
  await $`bun build --target=bun ${PRODUCTION_DEFINE} ${entry} --outfile ${join(dir, "prod.js")}`.quiet()
  expect(await Bun.file(join(dir, "prod.js")).text()).not.toContain("Cascading Update")
})

test("the production define leaves React DevTools, and its connection to localhost:8097, out of a minified bundle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chrn-devtools-"))
  dirs.push(dir)
  // @opentui/react without its core, whose native packages a cross-platform bundle can't all resolve here.
  const bundle = async (out: string, defines: string[]) => {
    await $`bun build --target=bun --minify --external @opentui/core ${defines} node_modules/@opentui/react/index.js --outfile ${join(dir, out)}`.quiet()
    return Bun.file(join(dir, out)).text()
  }
  expect(await bundle("plain.js", [])).toContain("connectToDevTools")
  expect(await bundle("prod.js", PRODUCTION_DEFINE)).not.toContain("connectToDevTools")
  // The define only reaches the reconciler's process.env["DEV"] in a minified build, so every compiled build minifies.
  for (const file of ["scripts/build.ts", "scripts/mac-checks/build.ts"]) {
    for (const line of (await Bun.file(file).text()).split("\n").filter((l) => l.includes("${PRODUCTION_DEFINE}"))) expect(line).toContain("--minify")
  }
})
