// The Bun runtime each release binary embeds, fetched once and checked against its pinned SHA-256
// (BUN_RUNTIMES) before `bun build --compile --compile-executable-path` takes it, so a runtime swapped
// upstream is refused rather than signed as the release.
import { $ } from "bun"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BUN_RUNTIMES, BUN_VERSION, PLATFORMS } from "./release-files"

type Platform = (typeof PLATFORMS)[number]

/** npm's name for a platform's Bun: arm64 is aarch64 there. */
const npmName = (platform: Platform) => `bun-${platform.replace("arm64", "aarch64")}`

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")

export interface RuntimeDeps {
  /** Where checked runtimes are kept between builds; each is checked again whenever it's used. */
  cacheDir: string
  /** Reads a URL's bytes. */
  download?: (url: string) => Promise<Uint8Array>
  pins?: Record<Platform, string>
  version?: string
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`couldn't fetch ${url}: ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

/** The path of `platform`'s Bun runtime, its SHA-256 checked against its pin. Throws, keeping nothing, when it doesn't match. */
export async function checkedRuntime(platform: Platform, deps: RuntimeDeps): Promise<string> {
  const pin = (deps.pins ?? BUN_RUNTIMES)[platform]
  const version = deps.version ?? BUN_VERSION
  const path = join(deps.cacheDir, `${npmName(platform)}-${version}`)
  if (existsSync(path) && sha256(path) === pin) return path
  rmSync(path, { force: true })
  mkdirSync(deps.cacheDir, { recursive: true })
  const work = mkdtempSync(join(deps.cacheDir, ".fetch-"))
  try {
    const url = `https://registry.npmjs.org/@oven/${npmName(platform)}/-/${npmName(platform)}-${version}.tgz`
    writeFileSync(join(work, "bun.tgz"), await (deps.download ?? fetchBytes)(url))
    await $`tar -xzf ${join(work, "bun.tgz")} -C ${work} package/bin/bun`.quiet()
    const unpacked = join(work, "package", "bin", "bun")
    const actual = sha256(unpacked)
    if (actual !== pin) throw new Error(`Bun ${version}'s runtime for ${platform} has SHA-256 ${actual}, not the pinned ${pin}; nothing was built`)
    chmodSync(unpacked, 0o755)
    renameSync(unpacked, path)
    return path
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
