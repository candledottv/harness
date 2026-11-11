// A test Mac's files for a release built with `bun scripts/build.ts --release <tag>`: the darwin-arm64 binary with
// the installer's test copy (an unsigned build installs with CANDLE_HARNESS_INSTALL_UNSIGNED_FOR_TESTING=1, its
// checksum still checked), and a scene kit: the fake Candle compiled for the Mac with test/two-chain-scene.sh, for a
// two-chain account made of stand-ins.
//
//   bun scripts/vm-bundle.ts <tag> <name>   writes dist/vm/<name>/ (its tarballs and SHA256SUMS.txt)
import { $ } from "bun"
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { NO_AUTOLOAD } from "./commit"
import { testCopy } from "./install-switch"
import { checkedRuntime } from "./runtimes"

const [tag, name] = process.argv.slice(2)
if (!tag || !name) throw new Error("usage: bun scripts/vm-bundle.ts <tag> <name>")
const release = join("dist/release", tag)
const out = join("dist/vm", name)
const stage = join(out, "stage")
const harness = `candle-harness-${tag}-darwin-arm64`
rmSync(out, { recursive: true, force: true })
mkdirSync(join(stage, harness), { recursive: true })
mkdirSync(join(stage, "m11-scene-kit"), { recursive: true })

for (const f of ["candle-harness-darwin-arm64", "SHA256SUMS", "latest.json"]) copyFileSync(join(release, f), join(stage, harness, f))
writeFileSync(join(stage, harness, "install.sh"), testCopy(readFileSync(join(release, "install.sh"), "utf8")), { mode: 0o755 })

const runtime = await checkedRuntime("darwin-arm64", { cacheDir: "node_modules/.cache/candle-harness-bun-runtimes" })
await $`bun build --compile ${NO_AUTOLOAD} --target=bun-darwin-arm64 --compile-executable-path=${runtime} test/fake-candle.ts --outfile ${join(stage, "m11-scene-kit", "fake-candle-darwin-arm64")}`.quiet()
copyFileSync("test/two-chain-scene.sh", join(stage, "m11-scene-kit", "m11-scene.sh"))

await $`tar -czf ../${harness}.tar.gz ${harness} && tar -czf ../m11-scene-kit.tar.gz m11-scene-kit`.cwd(stage).quiet()
rmSync(stage, { recursive: true })
const sums = await $`shasum -a 256 ${harness}.tar.gz m11-scene-kit.tar.gz`.cwd(out).text()
writeFileSync(join(out, "SHA256SUMS.txt"), sums)
for (const line of sums.trim().split("\n")) {
  const file = line.split(/\s+/)[1]!
  console.log(`${line}  ${statSync(join(out, file)).size.toLocaleString("en-US")} bytes`)
}
