import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BUN_RUNTIMES, BUN_VERSION, PLATFORMS } from "./release-files"
import { checkedRuntime } from "./runtimes"

const ROOT = join(import.meta.dir, "..")
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "chrn-runtime-"))
  dirs.push(dir)
  return dir
}
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")

/** An npm tarball shaped as Oven's: package/bin/bun holding `content`. */
function tarball(content: string): Uint8Array {
  const dir = scratch()
  mkdirSync(join(dir, "package", "bin"), { recursive: true })
  writeFileSync(join(dir, "package", "bin", "bun"), content)
  spawnSync("tar", ["-czf", join(dir, "bun.tgz"), "-C", dir, "package"])
  return new Uint8Array(readFileSync(join(dir, "bun.tgz")))
}

const pins = (pin: string) => Object.fromEntries(PLATFORMS.map((p) => [p, pin])) as typeof BUN_RUNTIMES

test("every release platform has Bun's runtime pinned by SHA-256", () => {
  expect(Object.keys(BUN_RUNTIMES).sort()).toEqual([...PLATFORMS].sort())
  for (const pin of Object.values(BUN_RUNTIMES)) expect(pin).toMatch(/^[0-9a-f]{64}$/)
  expect(BUN_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
})

test("a runtime that matches its pin is fetched from Oven's npm package, kept, and used", async () => {
  const cacheDir = scratch()
  const urls: string[] = []
  const path = await checkedRuntime("darwin-arm64", {
    cacheDir,
    pins: pins(sha("a runtime\n")),
    download: async (url) => (urls.push(url), tarball("a runtime\n")),
  })
  expect(urls).toEqual([`https://registry.npmjs.org/@oven/bun-darwin-aarch64/-/bun-darwin-aarch64-${BUN_VERSION}.tgz`])
  expect(readFileSync(path, "utf8")).toBe("a runtime\n")
  expect(statSync(path).mode & 0o111).not.toBe(0)
  // Kept, and checked again on the next build rather than fetched.
  expect(await checkedRuntime("darwin-arm64", { cacheDir, pins: pins(sha("a runtime\n")), download: async () => { throw new Error("fetched again") } })).toBe(path)
})

test("a runtime that isn't the pinned one is refused, and nothing is kept", async () => {
  const cacheDir = scratch()
  const run = checkedRuntime("linux-x64", { cacheDir, pins: pins(sha("a runtime\n")), download: async () => tarball("a swapped runtime\n") })
  await expect(run).rejects.toThrow("not the pinned")
  expect(readdirSync(cacheDir)).toEqual([])
})

test("a kept runtime changed since it was checked is fetched and checked again", async () => {
  const cacheDir = scratch()
  const opts = { cacheDir, pins: pins(sha("a runtime\n")), download: async () => tarball("a runtime\n") }
  const path = await checkedRuntime("linux-arm64", opts)
  writeFileSync(path, "changed\n")
  expect(await checkedRuntime("linux-arm64", opts)).toBe(path)
  expect(readFileSync(path, "utf8")).toBe("a runtime\n")
  rmSync(path)
  writeFileSync(path, "changed\n")
  await expect(checkedRuntime("linux-arm64", { ...opts, download: async () => tarball("changed again\n") })).rejects.toThrow("not the pinned")
  expect(existsSync(path)).toBe(false)
})

test("every release binary embeds a checked runtime, the host's included, built by the pinned Bun", () => {
  const build = readFileSync(join(ROOT, "scripts", "build.ts"), "utf8")
  expect(build).toContain("`--target=bun-${platform}`, `--compile-executable-path=${await checkedRuntime(platform")
  expect(build).toContain("if (all && Bun.version !== BUN_VERSION) throw")
})

test("the release workflow runs its Bun only after checking it against the linux-x64 pin", () => {
  const workflow = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "release.yaml"), "utf8")) as {
    jobs: Record<string, { steps: { name?: string; uses?: string; run?: string }[] }>
  }
  const steps = workflow.jobs.build?.steps ?? []
  for (const step of steps) expect(step.uses ?? "").not.toContain("setup-bun")
  const check = steps.findIndex((step) => step.name === "Bun, checked against its pin")
  const firstBun = steps.findIndex((step) => /(^|\n)\s*bun /.test(step.run ?? ""))
  expect(check).toBeGreaterThanOrEqual(0)
  expect(check).toBeLessThan(firstBun)
  // Its sed lines read this file's own pin and version.
  const run = steps[check]?.run ?? ""
  const reads = run.split("\n").filter((line) => /^\s*(version|pin)="\$\(sed /.test(line))
  expect(reads).toHaveLength(2)
  const read = spawnSync("bash", ["-c", `${reads.join("\n")}\necho "$version $pin"`], { cwd: ROOT, encoding: "utf8" })
  expect(read.stdout.trim()).toBe(`${BUN_VERSION} ${BUN_RUNTIMES["linux-x64"]}`)
  expect(run).toContain('sha256sum "$dir/package/bin/bun"')
})
