// Builds candle-harness as a single binary into dist/. With --all, for every target. With --release <tag>
// (v1.2.3), every target into dist/release/<tag>/ with the version from the tag, install.sh, SHA256SUMS
// and latest.json: the release's files, unsigned (the release workflow signs them). Run from the repo root.
import { $ } from "bun"
import { copyFileSync, mkdirSync, rmSync, statSync } from "node:fs"
import { buildCommit, commitDefine, PRODUCTION_DEFINE, SHIPPED_DEFINE, versionDefine } from "./commit"
import { binaryName, BUN_VERSION, PLATFORMS, releaseVersion, writeReleaseFiles } from "./release-files"
import { checkedRuntime } from "./runtimes"

const releaseAt = process.argv.indexOf("--release")
const tag = releaseAt >= 0 ? process.argv[releaseAt + 1] : undefined
if (releaseAt >= 0 && !tag) throw new Error("--release takes a tag, such as v1.2.3")
const version = tag === undefined ? undefined : releaseVersion(tag)
const all = tag !== undefined || process.argv.includes("--all")
// Every binary of a release embeds a runtime checked against its pin, which is for this Bun only.
if (all && Bun.version !== BUN_VERSION) throw new Error(`a release is built with Bun ${BUN_VERSION}, not ${Bun.version}`)
// Read once, before the install below could touch anything tracked.
const commit = buildCommit()
if (all) {
  // A normal install fetches only this machine's OpenTUI native package (@opentui/core-<os>-<arch>[-musl]);
  // a cross-built binary would be missing its library.
  await $`bun install ${"--os=*"} ${"--cpu=*"} ${"--libc=*"}`.quiet()
}

const outdir = tag === undefined ? "dist" : `dist/release/${tag}`
if (tag !== undefined) {
  rmSync(outdir, { recursive: true, force: true })
  mkdirSync(outdir, { recursive: true })
}
const builds = all
  ? PLATFORMS.map((platform) => ({ platform, out: `${outdir}/${binaryName(platform)}` }))
  : [{ platform: undefined, out: "dist/candle-harness" }]
const versionFlag = version === undefined ? [] : versionDefine(version)

for (const { platform, out } of builds) {
  // The host's target too: otherwise it embeds the compiler itself, which nothing here has checked.
  const targetFlag = platform
    ? [`--target=bun-${platform}`, `--compile-executable-path=${await checkedRuntime(platform, { cacheDir: "node_modules/.cache/candle-harness-bun-runtimes" })}`]
    : []
  await $`bun build --compile --minify ${targetFlag} ${commitDefine(commit)} ${versionFlag} ${PRODUCTION_DEFINE} ${SHIPPED_DEFINE} src/main.ts --outfile ${out}`.quiet()
  console.log(`${out}  ${(statSync(out).size / 1024 / 1024).toFixed(1)} MB  (${version ?? "unreleased"}, ${commit})`)
}

if (tag !== undefined && version !== undefined) {
  copyFileSync("install.sh", `${outdir}/install.sh`)
  const { sums } = writeReleaseFiles(outdir, version)
  process.stdout.write(sums)
  console.log(`${outdir}: ${tag}, unsigned`)
}
