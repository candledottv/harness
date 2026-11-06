// install.sh against Candle's real CLI release: the shipped script, unmodified,
// installs Candle's CLI from GitHub on a yes and verifies with it; and the real `candle verify`
// checks the signature path, with Candle's own signed release standing in for the Candle Harness's, which
// can't exist before its first release. Needs github.com. Run: bun run test:live scripts/install.live.test.ts
import { afterAll, expect, test } from "bun:test"
import { $ } from "bun"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commitDefine, versionDefine } from "./commit"
import { testCopy } from "./install-switch"
import { MIN_CANDLE_CLI } from "../src/setup/doctor"

const ROOT = join(import.meta.dir, "..")
const SCRIPT = readFileSync(join(ROOT, "install.sh"), "utf8")
const CLI_TAG = `cli-v${MIN_CANDLE_CLI}`
const PLATFORM = `${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`
const CANDLE = `candle-${PLATFORM}`
const HARNESS = `candle-harness-${PLATFORM}`
const CACHE = join(ROOT, "test", "fixtures", "raw", `candle-${CLI_TAG}`)
const latest = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "candle-cli-release", `${CLI_TAG}-latest.json`), "utf8")) as {
  assets: Record<string, { sha256: string }>
}

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")
const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** Candle's real binary and its bundle, fetched once into the git-ignored cache and checked against Candle's latest.json. */
async function candleFiles(): Promise<string> {
  mkdirSync(CACHE, { recursive: true })
  for (const name of [CANDLE, `${CANDLE}.sigstore.json`]) {
    if (!existsSync(join(CACHE, name))) await $`curl --proto =https -fsSL -o ${join(CACHE, name)} https://github.com/candledottv/cli/releases/download/${CLI_TAG}/${name}`.quiet()
  }
  expect(sha256(join(CACHE, CANDLE))).toBe(latest.assets[PLATFORM]?.sha256 ?? "")
  chmodSync(join(CACHE, CANDLE), 0o755)
  return CACHE
}

/** A folder for PATH holding `candle`, Candle's real binary. */
function candleOnPath(dir: string, cache: string): string {
  const bin = join(dir, "candle-bin")
  mkdirSync(bin)
  copyFileSync(join(cache, CANDLE), join(bin, "candle"))
  chmodSync(join(bin, "candle"), 0o755)
  return bin
}

function scene() {
  const dir = mkdtempSync(join(tmpdir(), "chrn-install-live-"))
  dirs.push(dir)
  const home = join(dir, "home")
  mkdirSync(home)
  return { dir, home, release: join(dir, "release") }
}

/** A release folder holding `binary` as this platform's candle-harness, with `bundle` beside it. */
function releaseOf(dir: string, binary: string, bundle: string | undefined, version: string, tag: string): void {
  mkdirSync(dir, { recursive: true })
  copyFileSync(binary, join(dir, HARNESS))
  if (bundle) copyFileSync(bundle, join(dir, `${HARNESS}.sigstore.json`))
  const sum = sha256(join(dir, HARNESS))
  writeFileSync(join(dir, "SHA256SUMS"), `${sum}  ${HARNESS}\n`)
  writeFileSync(join(dir, "latest.json"), JSON.stringify({ version, tag, assets: { [PLATFORM]: { name: HARNESS, sha256: sum } } }, null, 2))
}

function run(s: { dir: string; home: string }, args: string[], opts: { script?: string; path?: string[]; env?: Record<string, string> } = {}) {
  const script = join(s.dir, "install.sh")
  writeFileSync(script, opts.script ?? SCRIPT)
  const r = spawnSync("bash", [script, ...args], {
    cwd: s.dir,
    encoding: "utf8",
    env: {
      HOME: s.home,
      PATH: [...(opts.path ?? []), "/usr/bin", "/bin"].join(":"),
      SHELL: "/bin/zsh",
      TMPDIR: s.dir,
      CANDLE_NO_UPDATE_NOTIFIER: "1",
      CANDLE_HARNESS_INSTALL_TTY: join(s.dir, "no-terminal"),
      ...opts.env,
    },
  })
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
}

// The Candle Harness's identity swapped for Candle's CLI's, so Candle's signed binary is a release this copy accepts.
const asCandlesRelease = SCRIPT.replace("REPOSITORY='candledottv/harness'", "REPOSITORY='candledottv/cli'")
  .replace("TAG_PREFIX='v'", "TAG_PREFIX='cli-v'")
  .replace(
    "IDENTITY_PREFIX='https://github.com/candledottv/harness/.github/workflows/release.yaml@refs/tags/v'",
    "IDENTITY_PREFIX='https://github.com/candledottv/cli/.github/workflows/release.yaml@refs/tags/cli-v'",
  )

test("the shipped script, with no candle and a yes: Candle's CLI from GitHub, pinned and self-verified; an unsigned Candle Harness refused, then installed by the testing switch", async () => {
  const s = scene()
  const bin = join(s.dir, "candle-harness-built")
  await $`bun build --compile ${commitDefine("live")} ${versionDefine("0.0.1")} ${join(ROOT, "src", "main.ts")} --outfile ${bin}`.quiet()
  releaseOf(s.release, bin, undefined, "0.0.1", "v0.0.1")
  const first = run(s, ["--from", s.release, "--yes"])
  expect(first.code).toBe(1)
  const local = join(s.home, ".local", "bin")
  expect(first.out).toContain(`Installed the Candle CLI ${MIN_CANDLE_CLI} to ${local}/candle, checked against the SHA-256s this installer carries for Candle's release.`)
  expect(first.out).toContain("has no signature")
  expect(sha256(join(local, "candle"))).toBe(latest.assets[PLATFORM]?.sha256 ?? "")
  expect(existsSync(join(local, "candle-fido2"))).toBe(true)
  expect(existsSync(join(local, "candle-harness"))).toBe(false)
  // The CLI it installed is now the user's; with the test copy's switch, the Candle Harness goes beside it and runs.
  const second = run(s, ["--from", s.release], { script: testCopy(SCRIPT), path: [local], env: { CANDLE_HARNESS_INSTALL_UNSIGNED_FOR_TESTING: "1" } })
  expect(second.code).toBe(0)
  expect(second.out).toContain("candle-harness 0.0.1 (live)")
  expect(second.out).toContain(`Installed candle-harness 0.0.1 to ${local}/candle-harness.`)
}, 300_000)

test("the real candle verify: a release signed as the pinned identity installs", async () => {
  const cache = await candleFiles()
  const s = scene()
  releaseOf(s.release, join(cache, CANDLE), join(cache, `${CANDLE}.sigstore.json`), MIN_CANDLE_CLI, CLI_TAG)
  const r = run(s, ["--from", s.release, "--bin-dir", "~/bin"], { script: asCandlesRelease, path: [candleOnPath(s.dir, cache)] })
  expect(r.out).toContain(`signature checked by candle verify`)
  expect(r.code).toBe(0)
  expect(r.out).toContain(`\n${MIN_CANDLE_CLI}\n`)
}, 300_000)

test("the real candle verify: the same file presented as another tag is refused, nothing installed", async () => {
  const cache = await candleFiles()
  const s = scene()
  releaseOf(s.release, join(cache, CANDLE), join(cache, `${CANDLE}.sigstore.json`), "0.13.4", "cli-v0.13.4")
  const r = run(s, ["--from", s.release, "--bin-dir", "~/bin"], { script: asCandlesRelease, path: [candleOnPath(s.dir, cache)] })
  expect(r.code).toBe(1)
  expect(r.out).toContain("isn't signed by https://github.com/candledottv/cli/.github/workflows/release.yaml@refs/tags/cli-v0.13.4; nothing installed")
  expect(existsSync(join(s.home, "bin"))).toBe(false)
}, 300_000)

test("the real candle verify: a signed file from elsewhere is refused by the pinned identity, though latest.json beside it would let it through", async () => {
  const cache = await candleFiles()
  const s = scene()
  // Candle's own signed binary, offered as the Candle Harness's: its latest.json names the version, so candle
  // verify with no --identity would take Candle's identity from it and pass.
  releaseOf(s.release, join(cache, CANDLE), join(cache, `${CANDLE}.sigstore.json`), MIN_CANDLE_CLI, `v${MIN_CANDLE_CLI}`)
  const lax = spawnSync(join(cache, CANDLE), ["verify", join(s.release, HARNESS), "--bundle", join(s.release, `${HARNESS}.sigstore.json`)], {
    encoding: "utf8",
    env: { HOME: s.home, PATH: "/usr/bin:/bin", CANDLE_NO_UPDATE_NOTIFIER: "1" },
  })
  expect(lax.status).toBe(0)
  const r = run(s, ["--from", s.release, "--bin-dir", "~/bin"], { path: [candleOnPath(s.dir, cache)] })
  expect(r.code).toBe(1)
  expect(r.out).toContain(`isn't signed by https://github.com/candledottv/harness/.github/workflows/release.yaml@refs/tags/v${MIN_CANDLE_CLI}`)
  expect(existsSync(join(s.home, "bin"))).toBe(false)
}, 300_000)
