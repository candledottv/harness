// Pins install.sh to a Candle CLI release: the tag, the identity Candle
// signs it as, and the SHA-256 of each file install.sh may install, from Candle's own latest.json. Run it
// when the Candle Harness's minimum CLI moves (src/setup/doctor.ts MIN_CANDLE_CLI), after reading that CLI fresh:
//   bun scripts/pin-cli.ts cli-v0.13.9
// latest.json carries no signature of its own, and these pins are all install.sh trusts the CLI by: the
// candle it installs is only checked against them (its own `candle verify` can't vouch for itself). So
// before anything is written, every pinned file is downloaded, its SHA-256 matched to latest.json, and its
// Sigstore bundle verified with cosign as Candle's release workflow on that tag. It needs cosign on PATH.
// It keeps Candle's latest.json in test/fixtures/candle-cli-release/, which scripts/install.test.ts holds the pins to.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PLATFORMS } from "./release-files"

interface CandleLatest {
  version: string
  tag: string
  assets: Record<string, { name: string; sha256: string }>
  helpers: Record<string, { name: string; sha256: string }>
}

const BEGIN = "# BEGIN CLI PINS\n"
const END = "# END CLI PINS\n"

const ISSUER = "https://token.actions.githubusercontent.com"
const cliIdentity = (tag: string) => `https://github.com/candledottv/cli/.github/workflows/release.yaml@refs/tags/${tag}`

/** install.sh's pin block for one Candle CLI release. */
export function pinBlock(latest: CandleLatest): string {
  if (!/^cli-v\d+\.\d+\.\d+$/.test(latest.tag) || latest.tag !== `cli-v${latest.version}`) throw new Error(`not a CLI release: ${latest.tag}`)
  const lines: string[] = []
  for (const group of [latest.assets, latest.helpers]) {
    for (const platform of PLATFORMS) {
      const file = group[platform]
      if (!file || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error(`${latest.tag} has no checksum for ${platform}`)
      lines.push(`    ${file.name}) echo '${file.sha256}' ;;`)
    }
  }
  return [
    `CLI_TAG='${latest.tag}'`,
    `CLI_IDENTITY='${cliIdentity(latest.tag)}'`,
    "cli_pin() {",
    '  case "$1" in',
    ...lines,
    "    *) echo '' ;;",
    "  esac",
    "}",
    "",
  ].join("\n")
}

/** install.sh with its pin block replaced. */
export function withPins(script: string, latest: CandleLatest): string {
  const start = script.indexOf(BEGIN)
  const end = script.indexOf(END)
  if (start < 0 || end < start) throw new Error("install.sh has no CLI pin block")
  return `${script.slice(0, start + BEGIN.length)}${pinBlock(latest)}${script.slice(end)}`
}

export interface PinDeps {
  /** Reads one file of the release, by name. */
  download: (name: string) => Promise<Uint8Array>
  /** Runs cosign with these arguments; true when it exits 0. */
  cosign: (args: string[]) => boolean
}

/**
 * Checks every file install.sh would pin: its bytes match latest.json's SHA-256, and cosign verifies its
 * bundle as Candle's release workflow on `latest.tag`. Throws on the first that doesn't.
 */
export async function verifyRelease(latest: CandleLatest, deps: PinDeps): Promise<void> {
  pinBlock(latest)
  const dir = mkdtempSync(join(tmpdir(), "chrn-pin-cli-"))
  try {
    for (const group of [latest.assets, latest.helpers]) {
      for (const platform of PLATFORMS) {
        const file = group[platform]
        if (!file || !/^[\w.-]+$/.test(file.name)) throw new Error(`${latest.tag} has no file to pin for ${platform}`)
        const bytes = await deps.download(file.name)
        const actual = createHash("sha256").update(bytes).digest("hex")
        if (actual !== file.sha256) throw new Error(`${file.name}'s SHA-256 is ${actual}, but ${latest.tag}'s latest.json says ${file.sha256}`)
        writeFileSync(join(dir, file.name), bytes)
        writeFileSync(join(dir, `${file.name}.sigstore.json`), await deps.download(`${file.name}.sigstore.json`))
        const args = ["verify-blob", "--new-bundle-format", "--bundle", join(dir, `${file.name}.sigstore.json`)]
        args.push("--certificate-identity", cliIdentity(latest.tag), "--certificate-oidc-issuer", ISSUER, join(dir, file.name))
        if (!deps.cosign(args)) throw new Error(`${file.name} isn't signed as ${cliIdentity(latest.tag)}`)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Reads `tag`'s latest.json, verifies every file it pins, then writes install.sh's pins and the fixture under `root`. */
export async function pin(tag: string, root: string, deps: PinDeps & { latestJson: () => Promise<string> }): Promise<void> {
  const text = await deps.latestJson()
  const latest = JSON.parse(text) as CandleLatest
  if (latest.tag !== tag) throw new Error(`asked for ${tag}, but its latest.json names ${latest.tag}`)
  await verifyRelease(latest, deps)
  writeFileSync(join(root, "install.sh"), withPins(readFileSync(join(root, "install.sh"), "utf8"), latest))
  writeFileSync(join(root, "test", "fixtures", "candle-cli-release", `${tag}-latest.json`), text)
}

if (import.meta.main) {
  const tag = process.argv[2]
  if (!tag) throw new Error("usage: bun scripts/pin-cli.ts cli-v<version>")
  if (spawnSync("cosign", ["version"], { stdio: "ignore" }).status !== 0) throw new Error("cosign is needed, to verify Candle's signature on every file before it's pinned")
  const base = `https://github.com/candledottv/cli/releases/download/${tag}`
  const read = async (name: string) => {
    const response = await fetch(`${base}/${name}`)
    if (!response.ok) throw new Error(`couldn't read ${tag}'s ${name}: ${response.status}`)
    return response
  }
  await pin(tag, join(import.meta.dir, ".."), {
    latestJson: async () => (await read("latest.json")).text(),
    download: async (name) => new Uint8Array(await (await read(name)).arrayBuffer()),
    cosign: (args) => spawnSync("cosign", args, { stdio: "inherit" }).status === 0,
  })
  console.log(`install.sh pinned to ${tag}, every file verified with cosign. Move MIN_CANDLE_CLI to match.`)
}
