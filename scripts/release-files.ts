// What a release holds besides its binaries: SHA256SUMS and latest.json, written
// over exactly the release's assets. install.sh reads both, and the release workflow signs every file.
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** The platforms a release carries, as install.sh names them from `uname`. */
export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const

export const binaryName = (platform: string) => `candle-harness-${platform}`

/**
 * The Bun every release is built with. `bun build --compile` embeds a Bun runtime in each binary, fetched
 * for a cross-compiled target and the compiler itself for the host's, and nothing upstream pins either.
 * So each target's runtime is checked against its SHA-256 here before it's embedded (scripts/runtimes.ts),
 * and the release workflow checks its own bun against the linux-x64 one before running it. Each is the
 * `bin/bun` of @oven/bun-<os>-<arch>@BUN_VERSION on npm, which is the same file as Oven's GitHub release.
 * The workflow reads these lines with sed: keep each on one line, as written.
 */
export const BUN_VERSION = "1.4.4"
export const BUN_RUNTIMES: Record<(typeof PLATFORMS)[number], string> = {
  "darwin-arm64": "0a2237cdcfa0d16ef501d9acca9f0026309ef348bea7393a64e8d1e3609565cc",
  "darwin-x64": "c35307c7d45d65c5a385a58c4a6cb0bb9499e4e626abdee207c177a77ba666ab",
  "linux-arm64": "354c2b049c716aca07b2e5cddb887928ac58950675d1258bb6312083917793b6",
  "linux-x64": "10702245766b225e70bbf6235fd6b47214fd94b4760d00ffaed8ab0df57ac235",
}

/** The version a release tag names: `v1.2.3` and nothing else, since install.sh pins the signing identity to it. */
export function releaseVersion(tag: string): string {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(tag)
  if (!match?.[1]) throw new Error(`a release tag is v<major>.<minor>.<patch>, not ${JSON.stringify(tag)}`)
  return match[1]
}

/** The assets a release folder holds before SHA256SUMS and latest.json are written beside them. */
export const RELEASE_ASSETS: readonly string[] = [...PLATFORMS.map(binaryName), "install.sh"].sort()

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

/**
 * Writes SHA256SUMS (sha256sum's own format) and latest.json into `dir`, which must hold exactly
 * RELEASE_ASSETS: a stray file would be summed, signed and published with the release.
 */
export function writeReleaseFiles(dir: string, version: string): { sums: string; latest: string } {
  const present = readdirSync(dir).sort()
  if (present.join("\n") !== RELEASE_ASSETS.join("\n")) {
    throw new Error(`${dir} must hold exactly ${RELEASE_ASSETS.join(", ")}; it holds ${present.join(", ") || "nothing"}`)
  }
  const sums = `${RELEASE_ASSETS.map((name) => `${sha256(join(dir, name))}  ${name}`).join("\n")}\n`
  const assets = Object.fromEntries(
    PLATFORMS.map((platform) => {
      const name = binaryName(platform)
      return [platform, { name, sha256: sha256(join(dir, name)), size: statSync(join(dir, name)).size }]
    }),
  )
  const latest = `${JSON.stringify({ version, tag: `v${version}`, assets, installer: { name: "install.sh", sha256: sha256(join(dir, "install.sh")) } }, null, 2)}\n`
  writeFileSync(join(dir, "SHA256SUMS"), sums)
  writeFileSync(join(dir, "latest.json"), latest)
  return { sums, latest }
}
