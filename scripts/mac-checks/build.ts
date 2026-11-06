// The Mac checks as one binary, so a test Mac runs them with no Bun:
// dist/mac-checks/mac-checks-<platform>, run as `mac-checks <check> [flags]`. first-run-<platform> beside them is the
// first-run script, for its Mac route. From the repo root:
//   bun scripts/mac-checks/build.ts [--platform darwin-arm64]
import { $ } from "bun"
import { mkdirSync, statSync } from "node:fs"
import { buildCommit, commitDefine, PRODUCTION_DEFINE, SHIPPED_DEFINE } from "../commit"

const at = process.argv.indexOf("--platform")
const platforms = at >= 0 ? [process.argv[at + 1]!] : ["darwin-arm64", "darwin-x64", "linux-arm64"]
const commit = buildCommit()
mkdirSync("dist/mac-checks", { recursive: true })
for (const platform of platforms) {
  const out = `dist/mac-checks/mac-checks-${platform}`
  await $`bun build --compile --minify --target=bun-${platform} ${commitDefine(commit)} ${PRODUCTION_DEFINE} ${SHIPPED_DEFINE} scripts/mac-checks/main.ts --outfile ${out}`.quiet()
  console.log(`${out}  ${(statSync(out).size / 1024 / 1024).toFixed(1)} MB  (${commit})`)
  const firstRun = `dist/mac-checks/first-run-${platform}`
  await $`bun build --compile --minify --target=bun-${platform} scripts/e2e/first-run.ts --outfile ${firstRun}`.quiet()
  console.log(`${firstRun}  ${(statSync(firstRun).size / 1024 / 1024).toFixed(1)} MB`)
}
