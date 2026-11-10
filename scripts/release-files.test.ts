import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pin, withPins } from "./pin-cli"
import { BUN_VERSION, binaryName, PLATFORMS, RELEASE_ASSETS, releaseVersion, writeReleaseFiles } from "./release-files"

const ROOT = join(import.meta.dir, "..")
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "chrn-release-"))
  dirs.push(dir)
  for (const name of RELEASE_ASSETS) writeFileSync(join(dir, name), `${name}\n`)
  return dir
}

test("the Bun a contributor needs is the Bun the release is built with", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { engines: { bun: string } }
  expect(pkg.engines.bun).toBe(`>=${BUN_VERSION}`)
  expect(readFileSync(join(ROOT, "CONTRIBUTING.md"), "utf8")).toContain(`[Bun](https://bun.sh) ${BUN_VERSION} or later`)
})

test("a release tag is v and three numbers, and nothing else", () => {
  expect(releaseVersion("v1.2.3")).toBe("1.2.3")
  for (const bad of ["1.2.3", "v1.2", "v1.2.3-rc1", "cli-v1.2.3", "v1.2.3 ", "V1.2.3"]) expect(() => releaseVersion(bad)).toThrow()
})

test("SHA256SUMS checks with sha256sum, and latest.json names the version, the tag and each binary's sum", () => {
  const dir = folder()
  writeReleaseFiles(dir, "1.2.3")
  const check = spawnSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: dir, encoding: "utf8" })
  expect(check.status).toBe(0)
  expect(check.stdout.trim().split("\n")).toHaveLength(RELEASE_ASSETS.length)
  const latest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"))
  expect(latest.version).toBe("1.2.3")
  expect(latest.tag).toBe("v1.2.3")
  for (const platform of PLATFORMS) {
    expect(latest.assets[platform].name).toBe(binaryName(platform))
    expect(readFileSync(join(dir, "SHA256SUMS"), "utf8")).toContain(`${latest.assets[platform].sha256}  ${binaryName(platform)}\n`)
  }
})

test("a folder holding anything but the release's assets is refused, since every file in it is published", () => {
  const stray = folder()
  writeFileSync(join(stray, "notes.txt"), "")
  expect(() => writeReleaseFiles(stray, "1.2.3")).toThrow("must hold exactly")
  const missing = folder()
  rmSync(join(missing, "install.sh"))
  expect(() => writeReleaseFiles(missing, "1.2.3")).toThrow("must hold exactly")
  const empty = mkdtempSync(join(tmpdir(), "chrn-release-"))
  dirs.push(empty)
  mkdirSync(join(empty, "sub"))
  expect(() => writeReleaseFiles(empty, "1.2.3")).toThrow()
})

test("pin-cli rewrites install.sh's pins from Candle's latest.json, and the shipped pins are exactly that", () => {
  const script = readFileSync(join(ROOT, "install.sh"), "utf8")
  const latest = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "candle-cli-release", "cli-v0.13.20-latest.json"), "utf8"))
  expect(withPins(script, latest)).toBe(script)
  const moved = withPins(script, { ...latest, version: "0.13.10", tag: "cli-v0.13.10" })
  expect(moved).toContain("CLI_TAG='cli-v0.13.10'")
  expect(moved).toContain("refs/tags/cli-v0.13.10'")
  expect(() => withPins(script, { ...latest, helpers: {} })).toThrow("no checksum")
})

describe("pin-cli verifies Candle's signature on every file before it pins anything", () => {
  const TAG = "cli-v9.9.9"
  const IDENTITY = `https://github.com/candledottv/cli/.github/workflows/release.yaml@refs/tags/${TAG}`
  const names = [...PLATFORMS.map((p) => `candle-${p}`), ...PLATFORMS.map((p) => `candle-fido2-${p}`)]
  const bytes = (name: string) => new TextEncoder().encode(`${name} as released\n`)
  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")
  const latest = {
    version: "9.9.9",
    tag: TAG,
    assets: Object.fromEntries(PLATFORMS.map((p) => [p, { name: `candle-${p}`, sha256: sha(bytes(`candle-${p}`)) }])),
    helpers: Object.fromEntries(PLATFORMS.map((p) => [p, { name: `candle-fido2-${p}`, sha256: sha(bytes(`candle-fido2-${p}`)) }])),
  }

  function scene(opts: { served?: (name: string) => Uint8Array; signedAs?: (name: string) => string } = {}) {
    const root = mkdtempSync(join(tmpdir(), "chrn-pin-"))
    dirs.push(root)
    mkdirSync(join(root, "test", "fixtures", "candle-cli-release"), { recursive: true })
    const script = readFileSync(join(ROOT, "install.sh"), "utf8")
    writeFileSync(join(root, "install.sh"), script)
    const verified: string[] = []
    const run = () =>
      pin(TAG, root, {
        latestJson: async () => JSON.stringify(latest),
        download: async (name) => (name.endsWith(".sigstore.json") ? new TextEncoder().encode(`bundle for ${name}`) : (opts.served ?? bytes)(name)),
        // A stand-in for cosign: the file and its bundle are on disk, and it's asked for Candle's identity.
        cosign: (args) => {
          const file = args.at(-1) ?? ""
          const name = file.split("/").at(-1) ?? ""
          expect(args.slice(0, 2)).toEqual(["verify-blob", "--new-bundle-format"])
          expect(readFileSync(args[args.indexOf("--bundle") + 1] ?? "", "utf8")).toBe(`bundle for ${name}.sigstore.json`)
          expect(args[args.indexOf("--certificate-oidc-issuer") + 1]).toBe("https://token.actions.githubusercontent.com")
          expect(sha(readFileSync(file))).toBe(sha(bytes(name)))
          const asked = args[args.indexOf("--certificate-identity") + 1]
          const ok = asked === IDENTITY && (opts.signedAs?.(name) ?? IDENTITY) === asked
          if (ok) verified.push(name)
          return ok
        },
      })
    const unchanged = () => {
      expect(readFileSync(join(root, "install.sh"), "utf8")).toBe(script)
      expect(existsSync(join(root, "test", "fixtures", "candle-cli-release", `${TAG}-latest.json`))).toBe(false)
    }
    return { root, run, verified, unchanged }
  }

  test("every pinned file verified as Candle's release on that tag, then the pins written", async () => {
    const s = scene()
    await s.run()
    expect(s.verified.sort()).toEqual(names.sort())
    expect(readFileSync(join(s.root, "install.sh"), "utf8")).toContain(`CLI_TAG='${TAG}'`)
  })

  test("a file whose bytes aren't latest.json's writes nothing", async () => {
    const s = scene({ served: (name) => (name === "candle-linux-x64" ? new TextEncoder().encode("swapped\n") : bytes(name)) })
    await expect(s.run()).rejects.toThrow("candle-linux-x64's SHA-256")
    s.unchanged()
  })

  test("a file cosign won't verify as Candle's release writes nothing", async () => {
    const s = scene({ signedAs: (name) => (name === "candle-fido2-darwin-arm64" ? "https://github.com/someone/else/.github/workflows/release.yaml@refs/tags/cli-v9.9.9" : IDENTITY) })
    await expect(s.run()).rejects.toThrow("candle-fido2-darwin-arm64 isn't signed")
    s.unchanged()
  })
})
